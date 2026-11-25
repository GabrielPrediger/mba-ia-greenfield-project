import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { User } from '../src/users/entities/user.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';
import {
  buildOriginalKey,
  buildThumbnailKey,
} from '../src/videos/storage-keys.util';
import { MAX_VIDEO_SIZE_BYTES } from '../src/videos/videos.constants';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
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
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // --- Shared helpers, mirroring test/auth.e2e-spec.ts's conventions ---

  async function captureConfirmationToken(
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
    return capturedToken;
  }

  /**
   * Registers, confirms and logs in a fresh user, returning a real access
   * token plus the id of the channel that registration auto-creates for it
   * (see UsersService#createUserWithChannel).
   */
  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ accessToken: string; channelId: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const user = await dataSource.manager.findOneByOrFail(User, { email });
    const channel = await dataSource.manager.findOneByOrFail(Channel, {
      user_id: user.id,
    });

    return {
      accessToken: loginRes.body.access_token,
      channelId: channel.id,
    };
  }

  /** Inserts a Video row directly, bypassing the upload flow, for read-path tests. */
  async function insertVideo(overrides: Partial<Video>): Promise<Video> {
    const video = dataSource.manager.create(Video, {
      id: randomUUID(),
      title: 'Test video',
      original_filename: 'sample.mp4',
      mime_type: 'video/mp4',
      size_bytes: '1024',
      status: VideoStatus.DRAFT,
      storage_key: `videos/${randomUUID()}/${randomUUID()}/original.mp4`,
      ...overrides,
    });
    return dataSource.manager.save(Video, video);
  }

  /** Puts a small real object into storage and returns its key. */
  async function putRealObject(
    channelId: string,
    videoId: string,
    contentType = 'video/mp4',
  ): Promise<string> {
    const key = buildOriginalKey(channelId, videoId, 'mp4');
    await storageService.putObject(
      key,
      Buffer.from('fake video bytes for range testing, padded a bit more'),
      contentType,
    );
    return key;
  }

  async function putRealThumbnail(
    channelId: string,
    videoId: string,
  ): Promise<string> {
    const key = buildThumbnailKey(channelId, videoId);
    await storageService.putObject(
      key,
      Buffer.from('fake jpeg bytes'),
      'image/jpeg',
    );
    return key;
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with a presigned part for every chunk the size requires', async () => {
      const { accessToken } = await registerConfirmAndLogin(
        'uploader1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My vacation video',
          filename: 'vacation.mp4',
          mimeType: 'video/mp4',
          // 2.5x the default 100MB part size → 3 parts
          sizeBytes: Math.floor(2.5 * 100 * 1024 * 1024),
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.uploadId).toBeTruthy();
      expect(res.body.storageKey).toContain(res.body.id);
      expect(res.body.parts).toHaveLength(3);
      expect(res.body.parts[0]).toEqual({
        partNumber: 1,
        url: expect.any(String),
      });

      const video = await dataSource.manager.findOneByOrFail(Video, {
        id: res.body.id,
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          title: 'No auth',
          filename: 'x.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(401);
    });

    it('returns 400 when sizeBytes exceeds the 10GB limit', async () => {
      const { accessToken } = await registerConfirmAndLogin(
        'uploader2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Too big',
          filename: 'big.mp4',
          mimeType: 'video/mp4',
          sizeBytes: MAX_VIDEO_SIZE_BYTES + 1,
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when title is missing', async () => {
      const { accessToken } = await registerConfirmAndLogin(
        'uploader3@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'x.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when mimeType does not start with video/', async () => {
      const { accessToken } = await registerConfirmAndLogin(
        'uploader4@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Not a video',
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/uploads/complete', () => {
    it('returns 200 with status processing after a real multipart upload is completed', async () => {
      const { accessToken } = await registerConfirmAndLogin(
        'completer1@example.com',
      );

      const initiated = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Real completion',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 6 * 1024 * 1024,
        })
        .expect(201);

      const parts = await Promise.all(
        initiated.body.parts.map(
          async (part: { partNumber: number; url: string }) => {
            const body = Buffer.alloc(
              part.partNumber === initiated.body.parts.length
                ? 1024
                : 5 * 1024 * 1024,
              'x',
            );
            const response = await fetch(part.url, { method: 'PUT', body });
            expect(response.status).toBe(200);
            return {
              partNumber: part.partNumber,
              eTag: response.headers.get('etag') ?? '',
            };
          },
        ),
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${initiated.body.id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      expect(res.body).toMatchObject({
        id: initiated.body.id,
        title: 'Real completion',
        status: 'processing',
        durationSeconds: null,
        metadata: null,
        errorMessage: null,
      });
      expect(res.body.createdAt).toBeDefined();
    }, 20000);

    it("returns 404 for a video that belongs to another caller's channel", async () => {
      const owner = await registerConfirmAndLogin('owner1@example.com');
      const intruder = await registerConfirmAndLogin('intruder1@example.com');

      const video = await insertVideo({
        channel_id: owner.channelId,
        status: VideoStatus.DRAFT,
        upload_id: 'fake-upload-id',
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/uploads/complete`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 when the video is already processing', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin(
        'completer2@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT_STATUS');
    });

    it('returns 409 when the video is already ready', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin(
        'completer3@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.READY,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT_STATUS');
    });

    it('returns 409 when the video is already in error', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin(
        'completer4@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.ERROR,
        error_message: 'boom',
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT_STATUS');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/uploads/complete`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(401);
    });
  });

  describe('GET /videos', () => {
    it("lists only the caller's own videos, across every status", async () => {
      const mine = await registerConfirmAndLogin('lister1@example.com');
      const other = await registerConfirmAndLogin('lister2@example.com');

      await insertVideo({
        channel_id: mine.channelId,
        title: 'Mine — draft',
        status: VideoStatus.DRAFT,
      });
      await insertVideo({
        channel_id: mine.channelId,
        title: 'Mine — ready',
        status: VideoStatus.READY,
      });
      await insertVideo({
        channel_id: other.channelId,
        title: 'Not mine',
        status: VideoStatus.READY,
      });

      const res = await request(app.getHttpServer())
        .get('/videos')
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .expect(200);

      expect(res.body).toHaveLength(2);
      expect(
        (res.body as Array<{ title: string }>).every((v) =>
          v.title.startsWith('Mine'),
        ),
      ).toBe(true);
      const statuses = (res.body as Array<{ status: string }>).map(
        (v) => v.status,
      );
      expect(statuses).toEqual(expect.arrayContaining(['draft', 'ready']));
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer()).get('/videos').expect(401);
    });
  });

  describe('GET /videos/:id', () => {
    it('returns 404 for a draft video', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'public1@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.DRAFT,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 for a processing video', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'public2@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 200 with public fields for a ready video, with no Authorization header', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'public3@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        title: 'Published video',
        status: VideoStatus.READY,
        duration_seconds: 42,
        metadata: {
          width: 1920,
          height: 1080,
          codec: 'h264',
          bitrate: 1000,
          frameRate: 30,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: video.id,
        title: 'Published video',
        channelId,
        durationSeconds: 42,
      });
      expect(res.body.status).toBeUndefined();
      expect(res.body.errorMessage).toBeUndefined();
    });
  });

  describe('GET /videos/:id/stream', () => {
    it('returns 302 with a Location that answers a Range request with a real 206 Partial Content', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'stream1@example.com',
      );
      const videoId = randomUUID();
      const storageKey = await putRealObject(channelId, videoId);
      await insertVideo({
        id: videoId,
        channel_id: channelId,
        status: VideoStatus.READY,
        storage_key: storageKey,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeTruthy();

      const rangedResponse = await fetch(location, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(rangedResponse.status).toBe(206);
      expect(rangedResponse.headers.get('content-range')).toBeTruthy();
    });

    it('returns 404 for a non-ready video', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'stream2@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/download', () => {
    it('returns 302 with a Location that serves the real object', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'download1@example.com',
      );
      const videoId = randomUUID();
      const storageKey = await putRealObject(channelId, videoId);
      await insertVideo({
        id: videoId,
        channel_id: channelId,
        status: VideoStatus.READY,
        storage_key: storageKey,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeTruthy();

      const downloaded = await fetch(location);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain(
        'attachment',
      );
    });

    it('returns 404 for a non-ready video', async () => {
      const { channelId } = await registerConfirmAndLogin(
        'download2@example.com',
      );
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.DRAFT,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/thumbnail', () => {
    it('returns 302 with a Location that serves the real thumbnail object', async () => {
      const { channelId } = await registerConfirmAndLogin('thumb1@example.com');
      const videoId = randomUUID();
      const storageKey = await putRealObject(channelId, videoId);
      const thumbnailKey = await putRealThumbnail(channelId, videoId);
      await insertVideo({
        id: videoId,
        channel_id: channelId,
        status: VideoStatus.READY,
        storage_key: storageKey,
        thumbnail_key: thumbnailKey,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/thumbnail`)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeTruthy();

      const downloaded = await fetch(location);
      expect(downloaded.status).toBe(200);
    });

    it('returns 404 when the ready video has no thumbnail yet', async () => {
      const { channelId } = await registerConfirmAndLogin('thumb2@example.com');
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.READY,
        thumbnail_key: null,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/thumbnail`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 for a non-ready video', async () => {
      const { channelId } = await registerConfirmAndLogin('thumb3@example.com');
      const video = await insertVideo({
        channel_id: channelId,
        status: VideoStatus.PROCESSING,
        thumbnail_key: null,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/thumbnail`)
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
