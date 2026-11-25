import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AbortMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import type { VideoProcessingJobData } from './queues/video-processing.queue';
import { VIDEO_PROCESSING_QUEUE } from './queues/video-processing.queue';

describe('VideosService (integration — real Postgres + real MinIO + real Redis)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let queue: Queue<VideoProcessingJobData>;
  let s3: S3Client;
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
        UsersModule,
        VideosModule,
      ],
    }).compile();

    await module.init();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    queue = module.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    close = () => module.close();

    const storage = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    s3 = new S3Client({
      endpoint: storage.publicEndpoint,
      region: storage.region,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
      forcePathStyle: true,
    });

    const user = await dataSource.manager.save(
      dataSource.manager.create(User, {
        email: `videos-service-spec-${randomUUID()}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    userId = user.id;
    const channel = await dataSource.manager.save(
      dataSource.manager.create(Channel, {
        name: 'Videos Service Spec',
        nickname: `videos-service-spec-${randomUUID().slice(0, 8)}`,
        user_id: userId,
      }),
    );
    channelId = channel.id;
  }, 30000);

  afterAll(async () => {
    // Drain the real, shared Redis queue before tearing down: completeUpload
    // above enqueues a real job, but this suite never runs a worker to
    // consume it. Left in place, a later *.integration-spec.ts file's
    // worker would pick it up and fail against a Video row this suite is
    // about to delete (see the queue cross-file test-isolation note in
    // docs/phases/phase-03-videos/progress.md).
    await queue.obliterate({ force: true });
    await dataSource.manager.delete(Video, { channel_id: channelId });
    await dataSource.manager.delete(Channel, { id: channelId });
    await dataSource.manager.delete(User, { id: userId });
    await close();
  }, 30000);

  describe('initiateUpload', () => {
    it('persists a draft video with the correct channel_id/storage_key and a real MinIO multipart upload', async () => {
      const result = await videosService.initiateUpload(userId, {
        title: 'Integration Test Video',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5 * 1024 * 1024,
      });

      const video = await dataSource.manager.findOneByOrFail(Video, {
        id: result.id,
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel_id).toBe(channelId);
      expect(video.storage_key).toBe(result.storageKey);
      expect(video.storage_key).toContain(channelId);

      // The returned uploadId must be real and valid: aborting it against
      // the real storage backend must succeed (it would fail with a 404-ish
      // NoSuchUpload error for a fabricated id).
      await expect(
        s3.send(
          new AbortMultipartUploadCommand({
            Bucket: 'videos',
            Key: result.storageKey,
            UploadId: result.uploadId,
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('completeUpload', () => {
    it('completes a real multipart upload against MinIO and enqueues exactly one real job', async () => {
      const initiated = await videosService.initiateUpload(userId, {
        title: 'Completion Test Video',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 6 * 1024 * 1024,
      });

      expect(initiated.parts.length).toBeGreaterThanOrEqual(1);
      const parts = await Promise.all(
        initiated.parts.map(async (part) => {
          const body = Buffer.alloc(
            part.partNumber === initiated.parts.length ? 1024 : 5 * 1024 * 1024,
            'x',
          );
          const response = await fetch(part.url, {
            method: 'PUT',
            body,
          });
          expect(response.status).toBe(200);
          return {
            partNumber: part.partNumber,
            eTag: response.headers.get('etag') ?? '',
          };
        }),
      );

      const before = await queue.getJobCounts('waiting', 'active');

      const completed = await videosService.completeUpload(
        userId,
        initiated.id,
        { parts },
      );

      expect(completed.status).toBe(VideoStatus.PROCESSING);

      const waitingJobs = await queue.getJobs([
        'waiting',
        'active',
        'completed',
      ]);
      const ourJobs = waitingJobs.filter(
        (j) => j.data.videoId === initiated.id,
      );
      expect(ourJobs).toHaveLength(1);

      const after = await queue.getJobCounts('waiting', 'active');
      expect(after.waiting + after.active).toBeGreaterThanOrEqual(
        before.waiting + before.active,
      );
    }, 20000);
  });

  describe('findOwnVideos', () => {
    it('returns only the caller channel videos, across multiple statuses', async () => {
      // Dedicated user/channel for this test — the shared `userId`/`channelId`
      // from beforeAll already accumulated videos from the initiateUpload/
      // completeUpload tests above, which would pollute the "mine" assertion.
      const mineUser = await dataSource.manager.save(
        dataSource.manager.create(User, {
          email: `mine-${randomUUID()}@example.com`,
          password: 'hash',
          is_confirmed: true,
        }),
      );
      const mineChannel = await dataSource.manager.save(
        dataSource.manager.create(Channel, {
          name: 'Mine',
          nickname: `mine-${randomUUID().slice(0, 8)}`,
          user_id: mineUser.id,
        }),
      );

      const otherUser = await dataSource.manager.save(
        dataSource.manager.create(User, {
          email: `other-${randomUUID()}@example.com`,
          password: 'hash',
          is_confirmed: true,
        }),
      );
      const otherChannel = await dataSource.manager.save(
        dataSource.manager.create(Channel, {
          name: 'Other',
          nickname: `other-${randomUUID().slice(0, 8)}`,
          user_id: otherUser.id,
        }),
      );

      await dataSource.manager.save(
        dataSource.manager.create(Video, {
          id: randomUUID(),
          channel_id: mineChannel.id,
          title: 'Mine — draft',
          status: VideoStatus.DRAFT,
          original_filename: 'a.mp4',
          mime_type: 'video/mp4',
          size_bytes: '1',
          storage_key: `videos/${mineChannel.id}/${randomUUID()}/original.mp4`,
        }),
      );
      await dataSource.manager.save(
        dataSource.manager.create(Video, {
          id: randomUUID(),
          channel_id: mineChannel.id,
          title: 'Mine — ready',
          status: VideoStatus.READY,
          original_filename: 'b.mp4',
          mime_type: 'video/mp4',
          size_bytes: '1',
          storage_key: `videos/${mineChannel.id}/${randomUUID()}/original.mp4`,
        }),
      );
      await dataSource.manager.save(
        dataSource.manager.create(Video, {
          id: randomUUID(),
          channel_id: otherChannel.id,
          title: 'Not mine',
          status: VideoStatus.READY,
          original_filename: 'c.mp4',
          mime_type: 'video/mp4',
          size_bytes: '1',
          storage_key: `videos/${otherChannel.id}/${randomUUID()}/original.mp4`,
        }),
      );

      const mine = await videosService.findOwnVideos(mineUser.id);

      expect(mine.every((v) => v.title.startsWith('Mine'))).toBe(true);
      expect(mine.some((v) => v.status === VideoStatus.DRAFT)).toBe(true);
      expect(mine.some((v) => v.status === VideoStatus.READY)).toBe(true);

      await dataSource.manager.delete(Video, { channel_id: otherChannel.id });
      await dataSource.manager.delete(Channel, { id: otherChannel.id });
      await dataSource.manager.delete(User, { id: otherUser.id });
      await dataSource.manager.delete(Video, { channel_id: mineChannel.id });
      await dataSource.manager.delete(Channel, { id: mineChannel.id });
      await dataSource.manager.delete(User, { id: mineUser.id });
    });
  });
});
