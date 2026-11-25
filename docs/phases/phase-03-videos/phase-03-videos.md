---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-25T11:36:24-00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T11:52:25-00:00"
  docs/phases/phase-03-videos/context.md: "2026-11-25T12:05:00-00:00"
  docs/phases/phase-03-videos/validation.md: "2026-11-25T12:08:00-00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-25T12:10:00-00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload (up to 10GB, via presigned S3/MinIO multipart upload — no bytes through the API), automatic background processing (duration/metadata extraction + thumbnail generation via a dedicated FFmpeg worker process consuming a BullMQ/Redis queue), a unique per-video URL, and streaming/download via presigned, range-capable redirects to object storage — establishing the storage/queue/worker infrastructure the target architecture reserves for this phase.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces, extend the Joi validation schema, install FFmpeg in the shared Docker image, and add the `minio`, `redis`, and `nestjs-worker` services to Docker Compose.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^12.0.2`, `bullmq@^6.7.10`, `@aws-sdk/client-s3@^3.1177.0`, `@aws-sdk/s3-request-presigner@^3.1177.0`
- Add `RUN apt update && apt install -y ffmpeg` to `Dockerfile.dev` (shared by both `nestjs-api` and `nestjs-worker` — `ffmpeg` on Debian pulls in `ffprobe` as part of the same package)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'`), `STORAGE_PUBLIC_ENDPOINT` (string, defaults to `STORAGE_ENDPOINT` when unset), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY_ID` (string, required), `STORAGE_SECRET_ACCESS_KEY` (string, required), `STORAGE_BUCKET` (string, default `'videos'`), `VIDEO_UPLOAD_PART_SIZE_BYTES` (number, default `104857600` — 100MB), `VIDEO_UPLOAD_MAX_SIZE_BYTES` (number, default `10737418240` — 10GB), `VIDEO_UPLOAD_URL_TTL_SECONDS` (number, default `3600`), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (number, default `300`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema; update `.env.example` with Docker Compose-compatible defaults (`STORAGE_ACCESS_KEY_ID=streamtube`, `STORAGE_SECRET_ACCESS_KEY=streamtube123`)
- Add to `nestjs-project/compose.yaml`:
  - `minio` — image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` (S3 API) and `9001:9001` (console), env `MINIO_ROOT_USER=streamtube` / `MINIO_ROOT_PASSWORD=streamtube123`, volume `minio-data:/data`, healthcheck `curl -f http://localhost:9000/minio/health/live`
  - `redis` — image `redis:7-alpine`, port `6379:6379`, healthcheck `redis-cli ping`
  - `nestjs-worker` — same `build` as `nestjs-api` (same `Dockerfile.dev`, same context/volume mount), command override to run the worker entrypoint, `depends_on` `db`, `redis`, `minio` all `condition: service_healthy`
  - `nestjs-api`'s `depends_on` extended with `redis` and `minio` (both `service_healthy`)

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `minio`, `redis`, and `nestjs-worker` alongside the existing services; `docker compose ps` shows all as `running`/healthy
- `docker compose exec nestjs-api ffmpeg -version` and `docker compose exec nestjs-api ffprobe -version` both succeed
- Application (API and worker) starts without errors when all new environment variables are provided; missing `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` causes a Joi validation error at bootstrap

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity (status lifecycle, storage keys, metadata) and its migration, following the project's entity conventions.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `channel_id` (uuid, FK → channels, not null), `title` (varchar(150), not null), `status` (enum `'draft'|'processing'|'ready'|'error'`, not null, default `'draft'`), `original_filename` (varchar(255), not null), `mime_type` (varchar(100), not null), `size_bytes` (bigint, not null), `storage_key` (varchar(500), not null, unique), `thumbnail_key` (varchar(500), nullable), `upload_id` (varchar(255), nullable), `duration_seconds` (int, nullable), `metadata` (jsonb, nullable), `error_message` (text, nullable), `created_at`/`updated_at` (Create/UpdateDateColumn). Define `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`; add an index on `(channel_id)` and `(status)`
- Create `src/videos/entities/video-status.enum.ts` — `export enum VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', ERROR = 'error' }`
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` against a running Postgres with the entity defined, and review the generated SQL
- Create `src/videos/videos.module.ts` (skeleton) — `TypeOrmModule.forFeature([Video])` in imports, exports `TypeOrmModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Enum column accepts only the 4 values, `status` defaults to `draft`, FK to `channels` enforced, `storage_key` unique constraint, nullable columns default to `null`, timestamps auto-populated |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the status enum type, the FK constraint to `channels`, and the unique constraint on `storage_key`
- Inserting a video with an invalid `status` value fails with a Postgres enum violation
- Inserting a video with a non-existent `channel_id` fails with a FK violation
- A newly inserted video has `status = 'draft'` by default when `status` is omitted

---

### SI-03.3 — StorageModule (S3/MinIO Client Wrapper)

**Description:** Build the storage abstraction used by both the API (presigning, multipart lifecycle, bucket bootstrap) and the worker (plain `PutObject`/`GetObject`).

**Technical actions:**

- Create `src/storage/storage.module.ts` — global-ish feature module (not root-global; imported explicitly by `VideosModule` and `VideoProcessingModule`) exporting `StorageService`
- Create `src/storage/storage.service.ts` — constructs an `internalClient` (endpoint = `STORAGE_ENDPOINT`) and a `publicClient` (endpoint = `STORAGE_PUBLIC_ENDPOINT`), both with `forcePathStyle: true`. `onModuleInit()` calls `HeadBucketCommand`, and on failure calls `CreateBucketCommand`, against the configured bucket (idempotent bootstrap per TD-07). Methods: `createMultipartUpload(key, contentType)`, `presignUploadPartUrl(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `presignGetUrl(key, { responseContentDisposition?, responseContentType?, ttlSeconds })`, `putObject(key, body, contentType)`, `getObjectBuffer(key)` (worker-side download — buffers the object to a caller-supplied temp file path via a writable stream, returns the local path)
- Create `src/storage/storage.constants.ts` — `STORAGE_INTERNAL_CLIENT`/`STORAGE_PUBLIC_CLIENT` tokens if constructed as separate providers (or kept as private fields on `StorageService` — implementation detail decided during implementation, both expose the same public method surface either way)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration (real MinIO) | Bucket bootstrap is idempotent (calling twice doesn't error), `putObject` + `getObjectBuffer` round-trip, `createMultipartUpload` → `presignUploadPartUrl` → real `fetch` PUT of a part → `completeMultipartUpload` round-trip produces a retrievable object, `presignGetUrl` with `responseContentDisposition` set produces a URL whose fetched response carries the expected `Content-Disposition` header, a ranged `fetch` (`Range: bytes=0-99`) against a presigned GET URL returns `206 Partial Content` with exactly 100 bytes |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Against the real `minio` Compose service: a full multipart upload (create → presign 2+ parts → PUT each part for real → complete) produces an object whose size matches the sum of the parts
- A presigned GET URL, fetched with a `Range` header, returns `206 Partial Content` and the correct byte slice — proving the project's streaming strategy (TD-05) against real infrastructure, not a mock
- Bucket bootstrap on a MinIO instance that already has the bucket does not throw

---

### SI-03.4 — Upload Initiation Endpoint

**Description:** `POST /videos/uploads` — pre-registers the video as `draft` and initiates the S3 multipart upload, returning presigned part URLs.

**Technical actions:**

- Create `src/videos/dto/create-video-upload.dto.ts` — `CreateVideoUploadDto { title: string (@IsString, @MinLength(1), @MaxLength(150)), filename: string (@IsString, @MinLength(1)), mimeType: string (@IsString, @Matches(/^video\//)), sizeBytes: number (@IsInt, @Min(1), @Max(10737418240)) }`
- Create `src/videos/dto/video-upload-response.dto.ts` — response DTO: `id`, `uploadId`, `storageKey`, `partSize`, `parts: { partNumber: number; url: string }[]`
- Create `src/channels/channels.service.ts` addition: `findByUserId(userId: string): Promise<Channel>` (throws `ChannelNotFoundException` if none — defensive; every user has exactly one channel per Phase 02, but the dependency must not be assumed silently)
- Create `src/common/exceptions/domain.exception.ts` additions: `ChannelNotFoundException` (404), `VideoNotFoundException` (404), `VideoNotInDraftStatusException` (409), `VideoUploadCompletionFailedException` (422)
- Create `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: resolves the caller's channel via `ChannelsService.findByUserId`, computes `storageKey = videos/{channelId}/{videoId}/original.{ext}` (extension derived from `mimeType`'s subtype or `filename`'s extension, sanitized), computes `partSize`/part count from `sizeBytes` and `VIDEO_UPLOAD_PART_SIZE_BYTES`, calls `StorageService.createMultipartUpload`, persists the `Video` row (`status: draft`, `upload_id` from storage), presigns every part URL, returns the response DTO
- Create `src/videos/videos.controller.ts` — `@Controller('videos')`, `@ApiTags('videos')`; `POST /videos/uploads`, `@ApiBearerAuth('access-token')`, `@HttpCode(201)`, delegates to `VideosService.initiateUpload(currentUser.sub, dto)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload` computes the correct part count/size for boundary sizes (exactly one part, exactly `N` parts, a remainder last part); throws on a channel-less user (mocked) |
| `src/videos/videos.service.integration-spec.ts` | Integration | `initiateUpload` persists a `draft` video row with the correct `channel_id`/`storage_key`, and a real multipart upload is actually created against MinIO (the returned `uploadId` is valid — a subsequent `AbortMultipartUploadCommand` against it succeeds) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` returns 201 with `parts` sized correctly for a given `sizeBytes`; 401 without a token; 400 for `sizeBytes` over 10GB, missing `title`, or a `mimeType` not starting with `video/` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos/uploads` with a valid body returns 201, a `draft` video is persisted, and the response's `parts` array has `ceil(sizeBytes / partSize)` entries, each a valid presigned MinIO URL
- Requesting `sizeBytes` greater than 10GB returns 400 `VALIDATION_ERROR` — the request never reaches the storage layer
- The endpoint requires authentication (401 without a bearer token)

---

### SI-03.5 — Upload Completion Endpoint and Queue Producer

**Description:** `POST /videos/:id/uploads/complete` — completes the multipart upload, flips the video to `processing`, and enqueues the background-processing job.

**Technical actions:**

- Create `src/videos/dto/complete-video-upload.dto.ts` — `CompleteVideoUploadDto { parts: CompletedPartDto[] }`, `CompletedPartDto { partNumber: number (@IsInt, @Min(1)), eTag: string (@IsString, @MinLength(1)) }`, nested validation via `@ValidateNested({ each: true })` + `@Type(() => CompletedPartDto)`
- Create `src/videos/queues/video-processing.queue.ts` — `export const VIDEO_PROCESSING_QUEUE = 'video-processing'; export const PROCESS_VIDEO_JOB = 'process-video'; export interface VideoProcessingJobData { videoId: string }`
- Update `src/videos/videos.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` added to imports (producer-side registration only — the consumer/`WorkerHost` is registered in `VideoProcessingModule`, never here)
- Update `src/videos/videos.service.ts` — `completeUpload(userId, videoId, dto)`: loads the video, verifies ownership (channel belongs to `userId`) and `status === draft` (else `VideoNotFoundException`/`VideoNotInDraftStatusException`), calls `StorageService.completeMultipartUpload` (catches storage errors and rethrows as `VideoUploadCompletionFailedException`), sets `status: processing`, `upload_id: null`, saves, enqueues `{ videoId }` with `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }`, returns the updated video
- Update `src/videos/videos.controller.ts` — `POST /videos/:id/uploads/complete`, `@ApiBearerAuth`, delegates to the service

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload` rejects a non-owned video and a non-`draft` video without touching storage or the queue (mocked) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real multipart completion against MinIO (uploads 2 real parts via `fetch` PUT, then completes) and a real job landing in the real Redis queue with the correct `videoId` payload (`queue.getJobs(['waiting'])`) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/uploads/complete` with valid parts returns 200 with `status: 'processing'`; 404 for someone else's video; 409 for a video already `processing`/`ready`/`error` |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- Completing a real multipart upload (2+ parts actually PUT to MinIO) transitions the video to `processing` and the object is retrievable from MinIO with the correct byte size
- Exactly one job is enqueued per successful completion, carrying `{ videoId }`
- Completing an already-non-draft video returns 409 `VIDEO_NOT_IN_DRAFT_STATUS` and does not re-enqueue a job

---

### SI-03.6 — FfmpegService and Test Fixture

**Description:** Build the FFmpeg/ffprobe wrapper used by the worker, and commit a tiny real video fixture for integration tests.

**Technical actions:**

- Generate `nestjs-project/test/fixtures/sample.mp4` — a ~2 second, small (<150KB) synthetic video with both a video and audio stream, via `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -f lavfi -i sine=frequency=1000:duration=2 -shortest sample.mp4`, committed to the repo so integration tests exercise real FFmpeg/ffprobe without any external download
- Create `src/ffmpeg/ffmpeg.service.ts` — `extractMetadata(filePath): Promise<{ durationSeconds: number; width: number; height: number; codec: string; bitrate: number; frameRate: number }>` via `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', filePath])`, parsing the JSON stdout (duration from `format.duration`, video-stream fields from the first stream with `codec_type: 'video'`); `generateThumbnail(filePath, outputPath, atSeconds): Promise<void>` via `execFile('ffmpeg', ['-y','-ss', String(atSeconds), '-i', filePath, '-vframes','1', outputPath])`
- Create `src/ffmpeg/ffmpeg.module.ts` — exports `FfmpegService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/ffmpeg/ffmpeg.service.integration-spec.ts` | Integration (real binaries) | `extractMetadata` against `test/fixtures/sample.mp4` returns `durationSeconds ≈ 2`, correct `width`/`height` (320×240); `generateThumbnail` produces a non-empty JPEG file at the requested path; `extractMetadata` against a non-video file rejects with a clear error (no silent empty result) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `extractMetadata` and `generateThumbnail` both run against the real `ffmpeg`/`ffprobe` binaries installed in the container — no mocked subprocess
- A corrupt/non-video input file causes both methods to reject (propagate the error), never to return a fabricated empty success

---

### SI-03.7 — VideoProcessingModule, Worker Process, and Status Lifecycle

**Description:** Build the BullMQ consumer that performs the actual processing (download → extract metadata → generate thumbnail → upload thumbnail → mark ready), the standalone worker entrypoint, and the failure-handling path (TD-06).

**Technical actions:**

- Create `src/videos/video-processing/video-processing.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `StorageModule`, `FfmpegModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; providers: `VideoProcessor`
- Create `src/videos/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) export class VideoProcessor extends WorkerHost`: `process(job)` loads the video by `job.data.videoId`; **idempotency guard** — if `video.status !== 'processing'` (e.g. already `ready` from a prior successful attempt that crashed before BullMQ recorded completion), return immediately (no-op); downloads the original to a temp file (`os.tmpdir()`), runs `FfmpegService.extractMetadata`, runs `FfmpegService.generateThumbnail` at `Math.min(2, duration * 0.1)` seconds, uploads the thumbnail buffer via `StorageService.putObject`, updates the video row (`status: ready`, `duration_seconds`, `metadata`, `thumbnail_key`), deletes the temp file(s) in a `finally` block (always, success or throw); **does not catch-and-swallow** — any error during download/extract/thumbnail propagates so BullMQ's own retry/backoff (TD-01/TD-06) drives re-attempts
- Add `@OnWorkerEvent('failed') onFailed(job, error)` — if `job && job.attemptsMade >= (job.opts.attempts ?? 1)`, loads the video and persists `status: 'error'`, `error_message: error.message` (log-only, no rethrow — the sanctioned background-task exception in `nestjs-services.md`)
- Create `src/worker/worker.module.ts` — root module for the standalone process: `ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig, storageConfig, queueConfig] })`, `TypeOrmModule.forRootAsync(...)` (same config as `AppModule`), `BullModule.forRootAsync(...)`, `VideoProcessingModule`. Deliberately excludes `AuthModule`, `MailModule`, `ThrottlerModule`, and all HTTP-only providers/controllers
- Create `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule, { logger: ... })`; no `.listen()` — the process stays alive because the BullMQ `Worker` holds an open Redis connection
- Update `nestjs-project/package.json` scripts: `"start:worker:dev": "nest start --watch --entryFile worker/main"`, `"start:worker:prod": "node dist/worker/main"`; update `nest-cli.json` if a second entry needs registering (or compiled via the default `dist/worker/main.js` path from the shared `tsc` build — confirmed during implementation which the Nest CLI needs)
- Update `compose.yaml`'s `nestjs-worker` command (from SI-03.1) to run `npm run start:worker:dev`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processing/video.processor.integration-spec.ts` | Integration (real Postgres + real MinIO + real FFmpeg; BullMQ `Worker` exercised directly, not through the full HTTP app) | Processing a `processing`-status video whose `storage_key` points at a real uploaded `sample.mp4` transitions it to `ready` with a plausible `duration_seconds`, populated `metadata`, and a retrievable `thumbnail_key` object in MinIO; processing a video whose `storage_key` points at a corrupt/non-video object exhausts all 3 attempts and lands the row in `status: 'error'` with a non-empty `error_message`; re-running `process()` on an already-`ready` video is a no-op (idempotency guard) |
| `src/worker/worker.module.spec.ts` | Unit | Module compiles (DI wiring), and does not attempt to resolve any HTTP-only provider (e.g. `JwtAuthGuard`'s `APP_GUARD` registration is absent from this module graph) |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- A real end-to-end job (enqueued by SI-03.5's completion endpoint, consumed by this worker) takes a video from `processing` to `ready` with real duration/metadata/thumbnail — exercised against the real `redis`, `db`, and `minio` Compose services, no mocks
- A video whose underlying object is not a valid video file ends in `status: 'error'` after exactly 3 attempts, with `error_message` populated — never left stuck in `processing` forever, and never marked `error` after only 1 of 3 attempts
- The worker process starts via `npm run start:worker:dev` / the `nestjs-worker` Compose service without needing any HTTP-only module (no port bound, no `ThrottlerModule`)

---

### SI-03.8 — Public Read Endpoints (Metadata, List, Stream, Download, Thumbnail)

**Description:** The consumer-facing endpoints: an authenticated "my videos" list, and the public (anonymous-allowed) metadata/stream/download/thumbnail endpoints that only ever expose `ready` videos.

**Technical actions:**

- Create `src/videos/dto/video-response.dto.ts` — `id`, `title`, `channelId`, `status`, `durationSeconds`, `metadata`, `errorMessage`, `createdAt` (full detail — used by the "mine" endpoint)
- Create `src/videos/dto/public-video-response.dto.ts` — `id`, `title`, `channelId`, `durationSeconds`, `metadata`, `createdAt` (no `status`/`errorMessage` — a public video is always implicitly `ready`)
- Update `src/videos/videos.service.ts`:
  - `findOwnVideos(userId)` — all videos for the caller's channel, any status, newest first
  - `findPublicVideo(videoId)` — returns the video only if `status === 'ready'`, else throws `VideoNotFoundException`
  - `getStreamRedirectUrl(videoId)` / `getDownloadRedirectUrl(videoId)` / `getThumbnailRedirectUrl(videoId)` — each resolves the `ready` video (reusing `findPublicVideo`; `getThumbnailRedirectUrl` additionally requires `thumbnail_key` to be set, else `VideoNotFoundException`), then calls `StorageService.presignGetUrl` with the appropriate `storage_key`/`thumbnail_key`, `responseContentDisposition` (download only), `responseContentType`, and `VIDEO_PLAYBACK_URL_TTL_SECONDS`
- Update `src/videos/videos.controller.ts`:
  - `GET /videos` (`@ApiBearerAuth`) → `findOwnVideos(currentUser.sub)`
  - `GET /videos/:id` (`@Public()`) → `findPublicVideo(id)`
  - `GET /videos/:id/stream` (`@Public()`) → `@Res() res`, `res.redirect(302, url)`
  - `GET /videos/:id/download` (`@Public()`) → same, download URL
  - `GET /videos/:id/thumbnail` (`@Public()`) → same, thumbnail URL

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `findPublicVideo` rejects non-`ready` videos (mocked); `getThumbnailRedirectUrl` rejects a `ready` video with no `thumbnail_key` |
| `src/videos/videos.service.integration-spec.ts` | Integration | `findOwnVideos` returns only the caller's channel's videos across multiple statuses |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos` (authenticated) lists only the caller's own videos including non-ready ones; `GET /videos/:id` returns 404 for a `draft`/`processing` video and 200 for `ready`; `GET /videos/:id/stream` and `/download` and `/thumbnail` return 302 with a `Location` header for a `ready` video (and the e2e test itself follows the `Location` with a `Range` header, asserting a real `206 Partial Content` from MinIO) and 404 for a non-ready video; no endpoint in this SI requires authentication |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- Anonymous requests can fetch metadata, stream (with working `Range`/`206`), download, and thumbnail for any `ready` video — no token required
- A `draft`/`processing`/`error` video is invisible to anonymous requests (404) but visible, with full status detail, to its owner via `GET /videos`
- Following a `stream`/`download` redirect's `Location` with a `Range` header reaches MinIO directly and returns `206 Partial Content` with the correct byte range — proving TD-05 end-to-end, not just that a redirect was issued

---

### SI-03.9 — Full End-to-End Upload-to-Playback Test

**Description:** One comprehensive e2e test exercising the entire pipeline for real: register/login → initiate upload → PUT real parts to MinIO → complete → wait for the real worker to process → assert `ready` with metadata/thumbnail → stream with Range → download.

**Technical actions:**

- Create `test/videos-pipeline.e2e-spec.ts` — uses the real app (`AppModule`), a real authenticated user/channel (reusing the existing auth e2e helpers), uploads `test/fixtures/sample.mp4` split into 2 real parts via real `fetch` PUT calls to the presigned URLs, completes the upload, then polls `GET /videos` (owner view) for up to a bounded timeout until `status` leaves `processing` (requires the real `nestjs-worker` service — or, for test-suite self-containment, the test boots its own in-process `VideoProcessor` consumer against the same queue/DB/storage so the e2e suite does not have an external-process timing dependency; **decision taken at implementation time**, documented in `progress.md`), asserts `status === 'ready'`, `durationSeconds` is close to the fixture's real duration, `metadata` is populated, then follows the `stream` redirect with a `Range` header and asserts `206`, and follows `download` and asserts the full file size matches

**Dependencies:** SI-03.8

**Acceptance criteria:**

- The full pipeline passes against real Postgres, real Redis, real MinIO, and real FFmpeg — no component mocked anywhere in this test
- The test is deterministic (bounded polling with a generous timeout, not a fixed `sleep` that could flake)

---

### SI-03.10 — Documentation and Definition of Done

**Description:** Update `CLAUDE.md` (root and `nestjs-project/`) with the videos section reflecting the real, implemented code, and verify the full Definition of Done.

**Technical actions:**

- Update root `CLAUDE.md` — Architecture section: Message Queue is no longer "(TBD)", list it as BullMQ/Redis; mention the `nestjs-worker` container
- Update `nestjs-project/CLAUDE.md` — add a "Videos / Storage / Queue" section documenting: the `videos` module and its endpoints, the `StorageModule` and the internal/public endpoint split (TD-05 hostname note), the `nestjs-worker` service and how to run/observe it (`docker compose logs nestjs-worker`), the `VIDEO_UPLOAD_PART_SIZE_BYTES`/`VIDEO_UPLOAD_MAX_SIZE_BYTES`/TTL env vars, and the video status lifecycle
- Run, inside the `nestjs-api` container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`, `npm run build`
- Update `docs/phases/phase-03-videos/progress.md` with final per-SI status

**Dependencies:** SI-03.9

**Acceptance criteria:**

- All of: unit+integration suite green, e2e suite green, `npx tsc --noEmit` exits 0, `npm run lint` passes, `npm run build` succeeds
- `CLAUDE.md` (root and `nestjs-project/`) contains no reference to a file, endpoint, or behavior that does not exist in the committed code

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Also the public "unique URL" identifier (TD-04) |
| channel_id | uuid | FK → channels.id, not null | Owning channel |
| title | varchar(150) | not null | |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | TD-06 lifecycle |
| original_filename | varchar(255) | not null | As supplied at upload initiation |
| mime_type | varchar(100) | not null | Must start with `video/` (DTO-validated) |
| size_bytes | bigint | not null | ≤ `VIDEO_UPLOAD_MAX_SIZE_BYTES` (10GB) |
| storage_key | varchar(500) | not null, unique | `videos/{channelId}/{videoId}/original.{ext}` (TD-07) |
| thumbnail_key | varchar(500) | nullable | Set once the worker generates the thumbnail |
| upload_id | varchar(255) | nullable | S3 multipart upload id; cleared (`null`) once completed |
| duration_seconds | integer | nullable | Set by the worker |
| metadata | jsonb | nullable | `{ width, height, codec, bitrate, frameRate }`, set by the worker |
| error_message | text | nullable | Set on final processing failure (TD-06) |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one)
**Indexes:** `(storage_key)` — unique; `(channel_id)`; `(status)`

### API Contracts

#### POST /videos/uploads (SI-03.4)

**Request headers:** Authorization: Bearer `<access_token>`

**Request body:**
- title: string, required — 1–150 chars
- filename: string, required
- mimeType: string, required — must start with `video/`
- sizeBytes: number, required — 1 to 10,737,418,240 (10GB)

**Response 201:**
- id: string (uuid)
- uploadId: string
- storageKey: string
- partSize: number
- parts: `{ partNumber: number; url: string }[]`

**Error responses:**
- 400 validation error: invalid body, or `sizeBytes` over 10GB
- 401: missing/invalid access token

---

#### POST /videos/:id/uploads/complete (SI-03.5)

**Request headers:** Authorization: Bearer `<access_token>`

**Request body:**
- parts: `{ partNumber: number; eTag: string }[]`, required, non-empty

**Response 200:** Video resource (`id`, `title`, `status: 'processing'`, `durationSeconds: null`, `metadata: null`, `errorMessage: null`, `createdAt`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video doesn't exist or doesn't belong to the caller's channel
- 409 VIDEO_NOT_IN_DRAFT_STATUS: video is not `draft`
- 422 VIDEO_UPLOAD_COMPLETION_FAILED: storage rejected the completion (e.g., ETag/part mismatch)
- 400 validation error: malformed body
- 401: missing/invalid access token

---

#### GET /videos (SI-03.8)

**Request headers:** Authorization: Bearer `<access_token>`

**Response 200:** Video resource array (all statuses, caller's channel only)

**Error responses:** 401: missing/invalid access token

---

#### GET /videos/:id (SI-03.8)

**Response 200:** Public video resource (`id`, `title`, `channelId`, `durationSeconds`, `metadata`, `createdAt`) — only for `status: 'ready'`

**Error responses:** 404 VIDEO_NOT_FOUND: video doesn't exist, or is not `ready`

---

#### GET /videos/:id/stream (SI-03.8)

**Response 302:** `Location` header — presigned MinIO/S3 GET URL (inline, `ResponseContentType` = the video's `mime_type`), TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`. The client's own subsequent request against `Location` (with or without a `Range` header) is answered directly by storage — `206 Partial Content` for a ranged request.

**Error responses:** 404 VIDEO_NOT_FOUND: not `ready`

---

#### GET /videos/:id/download (SI-03.8)

**Response 302:** `Location` header — presigned GET URL with `ResponseContentDisposition: attachment; filename="<original_filename>"`, same TTL.

**Error responses:** 404 VIDEO_NOT_FOUND: not `ready`

---

#### GET /videos/:id/thumbnail (SI-03.8)

**Response 302:** `Location` header — presigned GET URL for `thumbnail_key`, `ResponseContentType: image/jpeg`, same TTL.

**Error responses:** 404 VIDEO_NOT_FOUND: not `ready`, or `thumbnail_key` not yet set

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|----------------|-------|
| POST /videos/uploads | | ✓ | Owner = caller's channel |
| POST /videos/:id/uploads/complete | | ✓ | Must own the video (404 if not) |
| GET /videos | | ✓ | Returns only caller's channel's videos |
| GET /videos/:id | ✓ | | Only `ready` videos, regardless of caller |
| GET /videos/:id/stream | ✓ | | Only `ready` videos |
| GET /videos/:id/download | ✓ | | Only `ready` videos |
| GET /videos/:id/thumbnail | ✓ | | Only `ready` videos with a thumbnail |

### Error Catalog

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the current user | Defensive — should not occur given Phase 02's 1:1 auto-creation |
| VIDEO_NOT_FOUND | 404 | Video not found | Video doesn't exist, belongs to another channel (owner-only endpoints), or isn't `ready` (public endpoints) |
| VIDEO_NOT_IN_DRAFT_STATUS | 409 | Video is not in draft status | `POST /videos/:id/uploads/complete` on a non-`draft` video |
| VIDEO_UPLOAD_COMPLETION_FAILED | 422 | Failed to complete the video upload | Storage rejected `CompleteMultipartUpload` (e.g., ETag/part mismatch) |

### Events / Messages (BullMQ)

**Queue:** `video-processing` (Redis-backed, `@nestjs/bullmq`)

**Job:** `process-video`

**Payload:**
```typescript
interface VideoProcessingJobData {
  videoId: string; // uuid
}
```

**Producer:** `VideosService.completeUpload`, after a successful `CompleteMultipartUpload` and `status: processing` is persisted.

**Job options:** `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }`

**Consumer:** `VideoProcessor` (`VideoProcessingModule`, worker process only). On success: updates the video to `ready` with `durationSeconds`/`metadata`/`thumbnailKey` directly inside `process()`. On failure: lets the error propagate (drives BullMQ's retry); `@OnWorkerEvent('failed')` persists `status: 'error'` + `errorMessage` only once `job.attemptsMade >= job.opts.attempts` (final failure, not an in-flight retry).

**Dead-letter equivalent:** BullMQ's own retained `failed` job set (`queue.getJobs(['failed'])`) — no separate DLQ table (TD-01).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.6

SI-03.2 + SI-03.3
└── SI-03.4
    └── SI-03.5
        └── SI-03.7 (also needs SI-03.6)
            └── SI-03.8
                └── SI-03.9
                    └── SI-03.10
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.6 (parallel) → SI-03.4 → SI-03.5 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10

## Deliverables

- [ ] `minio`, `redis`, `nestjs-worker` services running in `compose.yaml` alongside the existing `nestjs-api`, `db`, `mailpit`
- [ ] `ffmpeg`/`ffprobe` installed in the shared Docker image
- [ ] `Video` entity + migration (enum status, FK to `channels`, unique `storage_key`)
- [ ] `StorageModule` — idempotent bucket bootstrap, multipart upload lifecycle, presigned GET (internal/public endpoint split per TD-05)
- [ ] Upload initiation (`POST /videos/uploads`) — presigned multipart part URLs, 10GB ceiling enforced
- [ ] Upload completion (`POST /videos/:id/uploads/complete`) — real multipart completion + BullMQ job enqueue
- [ ] `FfmpegService` — real `ffprobe` metadata extraction + real `ffmpeg` thumbnail generation (no deprecated `fluent-ffmpeg` dependency)
- [ ] `VideoProcessor` worker — consumes the real queue, processes a real uploaded file end-to-end, 3-attempt exponential backoff, final-failure `error` status with message
- [ ] Standalone worker process (`src/worker/main.ts`, `nestjs-worker` Compose service) — isolated from the HTTP API's module graph
- [ ] Public read endpoints: metadata, stream (real `206 Partial Content` via redirect), download, thumbnail — all anonymous-accessible, all `ready`-gated
- [ ] "My videos" authenticated listing endpoint
- [ ] Video status lifecycle (`draft → processing → ready|error`) reflected in the database at every transition
- [ ] Unit + integration + e2e tests, all exercising real Postgres/Redis/MinIO/FFmpeg per the testing-guide's override documented in `context.md`
- [ ] `CLAUDE.md` (root + `nestjs-project/`) updated with the videos section, consistent with the implemented code
- [ ] Zero TypeScript compilation errors (`npx tsc --noEmit` exits 0)
- [ ] `npm run lint` passes
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
