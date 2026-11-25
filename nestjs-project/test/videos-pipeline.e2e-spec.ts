// This test forces the multipart-upload chunk size down to S3's real
// minimum part size (5MiB — anything smaller and a genuine S3/MinIO
// CompleteMultipartUpload call fails with EntityTooSmall for any part but
// the last one) so the ~5.8MB fixture below genuinely splits into two real
// parts instead of the default 100MB single part. It must be set before
// AppModule's ConfigModule evaluates storage.config.ts's registerAs
// factory, i.e. before Test.createTestingModule(...).compile() runs below.
process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024);

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
// Decision (documented in docs/phases/phase-03-videos/progress.md, SI-03.9):
// this suite imports VideoProcessingModule directly alongside AppModule so
// the same process that serves the HTTP API also runs a real BullMQ Worker
// consuming VIDEO_PROCESSING_QUEUE — the e2e suite is self-contained and
// deterministic instead of depending on the separately-started
// `nestjs-worker` container being up and warmed in time for this test.
import { VideoProcessingModule } from '../src/videos/video-processing/video-processing.module';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../src/videos/queues/video-processing.queue';

// A larger, real fixture than test/fixtures/sample.mp4 — at ~5.8MB it is
// big enough to require two genuine multipart parts at S3's 5MiB minimum
// part size (see the VIDEO_UPLOAD_PART_SIZE_BYTES override above), unlike
// the ~31KB sample.mp4 used by the other video test suites. Generated via:
// ffmpeg -f lavfi -i "testsrc=duration=8:size=640x480:rate=24" \
//   -f lavfi -i "sine=frequency=1000:duration=8" \
//   -c:v libx264 -b:v 6M -minrate 6M -maxrate 6M -bufsize 1M \
//   -x264-params "nal-hrd=cbr:force-cfr=1" -pix_fmt yuv420p -c:a aac \
//   -shortest test/fixtures/sample-large.mp4
const FIXTURE_PATH = join(__dirname, 'fixtures/sample-large.mp4');

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 30000, intervalMs = 500 } = {},
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

describe('Videos upload-to-playback pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<VideoProcessingJobData>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, VideoProcessingModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    // Triggers onModuleInit across the graph, including VideoProcessingModule's
    // real BullMQ Worker (via @nestjs/bullmq's WorkerHost lifecycle) and
    // StorageModule's bucket bootstrap.
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );

    // This suite's worker starts consuming VIDEO_PROCESSING_QUEUE the moment
    // it comes up (onModuleInit, above). Drain any job left behind by an
    // earlier *.e2e-spec.ts file in the same run (e.g. videos.e2e-spec.ts's
    // real completeUpload test, which has no worker of its own to consume
    // what it enqueues) so this worker never races a since-deleted Video row
    // — see the queue cross-file test-isolation note in
    // docs/phases/phase-03-videos/progress.md.
    await queue.obliterate({ force: true });
  }, 30000);

  afterAll(async () => {
    // Same reasoning as the beforeAll drain above, in reverse: don't leave
    // this suite's own queued/processed job bookkeeping behind for whatever
    // e2e file runs next.
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  it('takes a real upload all the way to ready and serves it back for playback and download', async () => {
    const accessToken = await registerConfirmAndLogin('pipeline@example.com');
    const fixtureBuffer = await readFile(FIXTURE_PATH);

    // 1. Initiate the upload — with VIDEO_UPLOAD_PART_SIZE_BYTES=16000 and
    // a ~31KB fixture, this yields exactly 2 parts.
    const initiated = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Pipeline fixture',
        filename: 'sample.mp4',
        mimeType: 'video/mp4',
        sizeBytes: fixtureBuffer.length,
      })
      .expect(201);

    expect(initiated.body.parts).toHaveLength(2);
    const videoId: string = initiated.body.id;

    // 2. PUT the two real chunks straight to storage, in part order.
    const partSize = initiated.body.partSize as number;
    const parts = await Promise.all(
      initiated.body.parts.map(
        async (part: { partNumber: number; url: string }) => {
          const start = (part.partNumber - 1) * partSize;
          const chunk = fixtureBuffer.subarray(
            start,
            Math.min(start + partSize, fixtureBuffer.length),
          );
          const response = await fetch(part.url, {
            method: 'PUT',
            body: chunk,
          });
          expect(response.status).toBe(200);
          return {
            partNumber: part.partNumber,
            eTag: response.headers.get('etag') ?? '',
          };
        },
      ),
    );

    // 3. Complete the upload — transitions to processing and enqueues the
    // real background job.
    const completed = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts })
      .expect(200);
    expect(completed.body.status).toBe('processing');

    // 4. Poll the owner's own video list — bounded, not a fixed sleep —
    // until the real worker (running in-process in this same app, see the
    // decision note above) takes it out of "processing".
    const finalVideo = await pollUntil(
      async () => {
        const res = await request(app.getHttpServer())
          .get('/videos')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        return (res.body as Array<{ id: string; status: string }>).find(
          (v) => v.id === videoId,
        )!;
      },
      (v) => v.status !== 'processing',
      { timeoutMs: 30000, intervalMs: 500 },
    );

    expect(finalVideo.status).toBe('ready');
    expect((finalVideo as any).durationSeconds).toBeGreaterThanOrEqual(7);
    expect((finalVideo as any).durationSeconds).toBeLessThanOrEqual(9);
    expect((finalVideo as any).metadata).toMatchObject({
      width: 640,
      height: 480,
      codec: 'h264',
    });
    expect((finalVideo as any).errorMessage).toBeNull();

    // 5. Stream with a Range header — must reach real storage and get a
    // genuine 206 Partial Content back, not just a redirect.
    const streamRedirect = await request(app.getHttpServer())
      .get(`/videos/${videoId}/stream`)
      .expect(302);
    const rangedResponse = await fetch(streamRedirect.headers.location, {
      headers: { Range: 'bytes=0-999' },
    });
    expect(rangedResponse.status).toBe(206);
    expect(rangedResponse.headers.get('content-range')).toBeTruthy();

    // 6. Download — must return the exact original file, byte for byte.
    const downloadRedirect = await request(app.getHttpServer())
      .get(`/videos/${videoId}/download`)
      .expect(302);
    const downloaded = await fetch(downloadRedirect.headers.location);
    expect(downloaded.status).toBe(200);
    const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
    expect(downloadedBytes.length).toBe(fixtureBuffer.length);
    expect(downloadedBytes.equals(fixtureBuffer)).toBe(true);

    // 7. The thumbnail the worker generated must also be a real,
    // retrievable object.
    const thumbnailRedirect = await request(app.getHttpServer())
      .get(`/videos/${videoId}/thumbnail`)
      .expect(302);
    const thumbnail = await fetch(thumbnailRedirect.headers.location);
    expect(thumbnail.status).toBe(200);
    const thumbnailBytes = await thumbnail.arrayBuffer();
    expect(thumbnailBytes.byteLength).toBeGreaterThan(0);
  }, 60000);
});
