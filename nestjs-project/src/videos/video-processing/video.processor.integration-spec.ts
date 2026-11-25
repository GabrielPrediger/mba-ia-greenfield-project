import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import databaseConfig from '../../config/database.config';
import storageConfig from '../../config/storage.config';
import queueConfig from '../../config/queue.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { FfmpegModule } from '../../ffmpeg/ffmpeg.module';
import { UsersModule } from '../../users/users.module';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { VideoProcessor } from './video.processor';
import {
  VIDEO_PROCESSING_QUEUE,
  PROCESS_VIDEO_JOB,
  VideoProcessingJobData,
} from '../queues/video-processing.queue';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'test/fixtures/sample.mp4',
);

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 20000, intervalMs = 250 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(
    `pollUntil timed out after ${timeoutMs}ms, last value: ${JSON.stringify(last)}`,
  );
}

describe('VideoProcessor (integration — real Postgres + real MinIO + real FFmpeg)', () => {
  let dataSource: DataSource;
  let storageService: StorageService;
  let queue: Queue<VideoProcessingJobData>;
  let userId: string;
  let channelId: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (cfg: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            password: cfg.password,
            database: cfg.name,
            autoLoadEntities: true,
            synchronize: false,
          }),
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        FfmpegModule,
        UsersModule,
      ],
      providers: [VideoProcessor],
    }).compile();

    await module.init();

    dataSource = module.get(DataSource);
    storageService = module.get(StorageService);
    queue = module.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    close = () => module.close();

    const user = await dataSource.manager.save(
      dataSource.manager.create(User, {
        email: `processor-spec-${randomUUID()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    userId = user.id;
    const channel = await dataSource.manager.save(
      dataSource.manager.create(Channel, {
        name: 'Processor Spec',
        nickname: `processor-spec-${randomUUID().slice(0, 8)}`,
        user_id: userId,
      }),
    );
    channelId = channel.id;
  }, 30000);

  afterAll(async () => {
    // Drain the real, shared Redis queue before tearing down: any job left
    // waiting/delayed here would otherwise be picked up by whichever later
    // *.integration-spec.ts file's worker runs next in the same
    // `--runInBand` process, failing against DB rows this suite just
    // deleted (see the queue cross-file test-isolation note in
    // docs/phases/phase-03-videos/progress.md).
    await queue.obliterate({ force: true });
    await dataSource.manager.delete(Video, { channel_id: channelId });
    await dataSource.manager.delete(Channel, { id: channelId });
    await dataSource.manager.delete(User, { id: userId });
    await close();
  }, 30000);

  it('takes a processing video with a real uploaded fixture to ready, with real duration/metadata/thumbnail', async () => {
    const videoId = randomUUID();
    const storageKey = `videos/${channelId}/${videoId}/original.mp4`;
    const fixtureBuffer = await readFile(FIXTURE_PATH);
    await storageService.putObject(storageKey, fixtureBuffer, 'video/mp4');

    await dataSource.manager.save(
      dataSource.manager.create(Video, {
        id: videoId,
        channel_id: channelId,
        title: 'Real fixture',
        status: VideoStatus.PROCESSING,
        original_filename: 'sample.mp4',
        mime_type: 'video/mp4',
        size_bytes: String(fixtureBuffer.length),
        storage_key: storageKey,
      }),
    );

    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { attempts: 1 });

    const finalVideo = await pollUntil(
      () => dataSource.manager.findOneByOrFail(Video, { id: videoId }),
      (v) => v.status !== VideoStatus.PROCESSING,
    );

    expect(finalVideo.status).toBe(VideoStatus.READY);
    expect(finalVideo.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(finalVideo.metadata?.width).toBe(320);
    expect(finalVideo.metadata?.height).toBe(240);
    expect(finalVideo.thumbnail_key).toBeTruthy();

    // The thumbnail must be a real, retrievable object in storage.
    const thumbTmpPath = `/tmp/${randomUUID()}.jpg`;
    await storageService.downloadToFile(
      finalVideo.thumbnail_key as string,
      thumbTmpPath,
    );
    const thumbStats = await readFile(thumbTmpPath);
    expect(thumbStats.length).toBeGreaterThan(0);
  }, 30000);

  it('exhausts all 3 attempts for a corrupt object and lands in error with a message', async () => {
    const videoId = randomUUID();
    const storageKey = `videos/${channelId}/${videoId}/original.mp4`;
    await storageService.putObject(
      storageKey,
      Buffer.from('this is not a real video file'),
      'video/mp4',
    );

    await dataSource.manager.save(
      dataSource.manager.create(Video, {
        id: videoId,
        channel_id: channelId,
        title: 'Corrupt fixture',
        status: VideoStatus.PROCESSING,
        original_filename: 'corrupt.mp4',
        mime_type: 'video/mp4',
        size_bytes: '30',
        storage_key: storageKey,
      }),
    );

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
    );

    const finalVideo = await pollUntil(
      () => dataSource.manager.findOneByOrFail(Video, { id: videoId }),
      (v) => v.status !== VideoStatus.PROCESSING,
      { timeoutMs: 20000 },
    );

    expect(finalVideo.status).toBe(VideoStatus.ERROR);
    expect(finalVideo.error_message).toBeTruthy();

    const failedJobs = await queue.getJobs(['failed']);
    const ourJob = failedJobs.find((j) => j.data.videoId === videoId);
    expect(ourJob?.attemptsMade).toBe(3);
  }, 30000);

  it('is a no-op when re-run against a video that already reached ready (idempotency guard)', async () => {
    const videoId = randomUUID();
    const storageKey = `videos/${channelId}/${videoId}/original.mp4`;
    const fixtureBuffer = await readFile(FIXTURE_PATH);
    await storageService.putObject(storageKey, fixtureBuffer, 'video/mp4');

    await dataSource.manager.save(
      dataSource.manager.create(Video, {
        id: videoId,
        channel_id: channelId,
        title: 'Already ready',
        status: VideoStatus.READY,
        original_filename: 'sample.mp4',
        mime_type: 'video/mp4',
        size_bytes: String(fixtureBuffer.length),
        storage_key: storageKey,
        duration_seconds: 2,
        thumbnail_key: 'some/existing/thumbnail.jpg',
      }),
    );

    await queue.add(PROCESS_VIDEO_JOB, { videoId }, { attempts: 1 });

    // Give the worker a moment to pick the job up and finish (it should be
    // a near-instant no-op since the guard returns immediately).
    await pollUntil(
      async () =>
        (await queue.getJobs(['completed'])).some(
          (j) => j.data.videoId === videoId,
        ),
      (done) => done === true,
      { timeoutMs: 10000 },
    );

    const video = await dataSource.manager.findOneByOrFail(Video, {
      id: videoId,
    });
    // Untouched — still exactly what was written above, proving process()
    // returned immediately instead of re-downloading/re-processing.
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.thumbnail_key).toBe('some/existing/thumbnail.jpg');
  }, 30000);
});
