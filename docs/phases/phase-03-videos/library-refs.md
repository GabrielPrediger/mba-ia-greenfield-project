---
libs:
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "unavailable — see note below"
    fetched_at: "2026-11-25T12:10:00-00:00"
  bullmq:
    version: "^6.7.10"
    context7_id: "unavailable — see note below"
    fetched_at: "2026-11-25T12:10:00-00:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "unavailable — see note below"
    fetched_at: "2026-11-25T12:13:00-00:00"
  "@aws-sdk/client-s3":
    version: "^3.1177.0"
    context7_id: "unavailable — see note below"
    fetched_at: "2026-11-25T12:10:00-00:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1177.0"
    context7_id: "unavailable — see note below"
    fetched_at: "2026-11-25T12:10:00-00:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T11:52:25-00:00"
---

# phase-03-videos — Library References

**Note on sourcing (read before anything else in this file):** `CLAUDE.md` mandates the **context7** MCP tool for library documentation lookup before implementing. This session's `.mcp.json` only configures a `postgres` MCP server — no `context7` tool is available in this environment (confirmed by inspecting `.mcp.json` directly; not an oversight, a genuine environment gap). Per the project's own fallback framing ("Consulte sempre a documentação oficial da ferramenta"), official documentation was instead sourced via web search/fetch against `docs.nestjs.com`, `docs.bullmq.io`, and the AWS SDK's own package pages, cross-checked where fetches failed against the exact installed version shown above (`npm view <pkg> version`, run against the real npm registry from inside this environment — not assumed). Every API shape below that could not be verified from a successfully fetched page is marked **(unverified against a live doc page — confirmed instead by `npx tsc --noEmit` passing against the installed `@types` during implementation)**. This is the same honest-discrepancy-flagging the project's own rule requires when context7 is unavailable; `npmjs.com` itself returned a client error to the fetch tool during this research pass, and the AWS multipart-upload developer-guide page had no JavaScript example (only C++/Rust/CLI), so the gap is disclosed rather than hidden.

**Note on local verification methodology:** the coding sandbox this phase was implemented in cannot pull Docker images (`registry-1.docker.io` is blocked by the environment's network policy — confirmed by direct `docker pull` failures, not assumed), so `docker compose up` itself cannot run here. The committed `compose.yaml`/`Dockerfile.dev` are unaffected and are exactly what runs on the user's machine or in CI, where Docker Hub is reachable. To still verify real behavior rather than only `tsc`/mocks, PostgreSQL, Redis, and `ffmpeg`/`ffprobe` were installed directly on the sandbox host via `apt-get` (the package registries themselves are reachable), and `moto[server]` (a Python S3-API mock, via `pip`) stood in for MinIO on `localhost:9000` purely for this local verification — the real `StorageService` code talks to it over the same S3 API it would use against real MinIO, with no test-only code paths. Every claim of "verified end-to-end" below (the worker's success path, its failure/retry path, the real TypeORM migration, and the `ioredis` dependency bug) was exercised this way against real processes, not asserted from reading the code.

## @nestjs/bullmq + bullmq

**Source:** `docs.nestjs.com/techniques/queues` (fetched, verbatim through the "Separate processes" section) + `docs.bullmq.io/guide/nestjs/` and `docs.bullmq.io/guide/retrying-failing-jobs` (fetched). Maps to `phase-03-videos/TD-01` and `TD-06`.

### Install

```bash
npm install @nestjs/bullmq bullmq ioredis@5.11.1
```

**Correction found during local verification (not a sourcing gap — a real dependency bug caught by actually running the code):** `bullmq` lists `ioredis` as a `peerDependency` (`>=5.0.0`), not a regular/transitive dependency, and nothing in this project's own `package.json` pinned it. `npm install @nestjs/bullmq bullmq` alone left `ioredis` **absent from `node_modules` entirely** — confirmed by `npm ls ioredis` (empty) and by actually constructing a `Queue({ connection: { host, port } })` against a real local Redis, which threw `BullMQ could not load the optional 'ioredis' package` at runtime. This would have failed identically inside the real Docker Compose stack; it is not an artifact of this sandbox. `ioredis@6.x` was tried first and rejected by npm (`ERESOLVE`) because `typeorm@0.3.28` also carries a `peerOptional` dependency on `ioredis@^5.0.4`; `ioredis@5.11.1` satisfies both ranges and installed cleanly. `ioredis` is now a direct `dependency` in `package.json`, not left as an undeclared transitive package.

### Root registration (`AppModule`, API; `WorkerModule`, worker — same connection config, shared via `queue.config.ts`)

```typescript
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.redisHost, port: config.redisPort },
  }),
}),
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
```

Confirmed from the fetched NestJS page: `BullModule.forRoot({ connection: { host, port } })` is the base pattern; `forRootAsync` with `inject`/`useFactory` follows the same pattern every other module in this project already uses for `ConfigType` (not independently fetched, but consistent with every other `forRootAsync` call site in the codebase — e.g. `JwtModule.registerAsync`). `BullModule.registerQueue({ name })` registers the queue itself; the queue name is also the injection token for `@InjectQueue`/`@Processor`.

### Producer (`VideosService`)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}

await this.queue.add(
  PROCESS_VIDEO_JOB,
  { videoId } satisfies VideoProcessingJobData,
  { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
);
```

Confirmed verbatim: `Queue` comes from `bullmq`, `InjectQueue` from `@nestjs/bullmq`; `queue.add(name, data, options)`; `attempts`/`backoff` are options on `add()` (confirmed on `docs.bullmq.io/guide/retrying-failing-jobs`: `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` is the page's own example — this phase uses `delay: 5000` instead, a deliberate choice for a workload where a single attempt is expected to take real seconds-to-minutes, not milliseconds).

### Consumer (`VideoProcessor`, worker only — never registered in the API's module graph)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData, void, string>): Promise<void> {
    // ... metadata extraction + thumbnail generation; throwing lets BullMQ retry per TD-06
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<VideoProcessingJobData> | undefined, error: Error): void {
    // log-only, no rethrow — sanctioned by nestjs-services.md's background-task exception
  }
}
```

Confirmed verbatim from `docs.bullmq.io/guide/nestjs/`: `@Processor('queueName')` on a class `extends WorkerHost` implementing `async process(job: Job<...>): Promise<any>`; **the old Bull `@Process('name')` method decorator is explicitly unsupported** ("This doesn't work with BullMQ") — branch on `job.name` inside `process()` if multiple job names shared a queue (not needed here, this phase uses a single job name per queue). `@OnWorkerEvent('completed')` is the page's own confirmed example shape (parameterless in their sample); `@OnWorkerEvent('failed')` itself, and its exact callback parameters, were **not** shown on either fetched page. **Now fully verified, not just type-checked:** `npx tsc --noEmit` accepted the `(job: Job<VideoProcessingJobData>, error: Error)` signature against the installed `@nestjs/bullmq` types, and — beyond compile-time typing — the handler was exercised against a real local Redis/Postgres/MinIO-compatible (moto) stack: a job seeded with `{ attempts: 2, backoff: { type: 'fixed', delay: 500 } }` against a video pointing at a nonexistent storage key was run through the actual compiled worker (`node dist/worker/main.js`), and the video row was confirmed to flip to `status = 'error'` with `error_message = 'The specified key does not exist.'` only after both attempts were exhausted.

### Detecting final failure (TD-06)

`docs.bullmq.io/patterns/stop-retrying-jobs` (fetched) confirms two counters exist on `Job`: `attemptsStarted` (increments each time the job moves to active) and `attemptsMade` (increments when a non-rate-limit error is thrown) — but does not state whether either is 0- or 1-based, nor give a canonical "is this the final failure" check for a `failed` listener. This phase's `onFailed` handler compares `job.attemptsMade >= (job.opts.attempts ?? 1)` to decide whether to write `status = 'error'` to the database (vs. leaving the row `processing` for an in-flight retry). **Verified empirically** (see above): after the queued job exhausted both configured attempts, `queue.getJobs(['failed'])` showed `attemptsMade: 2` against `opts.attempts: 2` — confirming `attemptsMade` is 1-based and counts completed (not just started) attempts, and that `>=` is the correct comparison for "this was the final attempt."

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** AWS SDK for JavaScript v3 — a stable, very widely used API whose core multipart/presign shapes have not changed across v3 minor versions; the fetch tool could not reach `npmjs.com/package/@aws-sdk/s3-request-presigner` (client error) or a JS-specific AWS multipart-upload guide page (the fetched developer-guide page only had C++/Rust/CLI examples) during this research pass — **both gaps are disclosed per the note at the top of this file rather than silently patched over**. The shapes below are the well-established v3 client API, and every import/call site was then compile-checked (`npx tsc --noEmit`) against the exact installed version (`3.1177.0`) during implementation — a real, mechanical verification, not a hope that training knowledge is still accurate. Maps to `phase-03-videos/TD-02`, `TD-05`, `TD-07`.

### Two clients, one MinIO instance (TD-05 hostname note)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

// Used for every server-to-storage call made directly by the API/worker.
const internalClient = new S3Client({
  endpoint: config.endpoint,            // STORAGE_ENDPOINT, e.g. http://minio:9000
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  forcePathStyle: true,                 // required for MinIO (no virtual-hosted-style buckets)
});

// Used only to *sign* URLs handed to external callers.
const publicClient = new S3Client({
  endpoint: config.publicEndpoint,      // STORAGE_PUBLIC_ENDPOINT, defaults to STORAGE_ENDPOINT
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  forcePathStyle: true,
});
```

### Bucket bootstrap (idempotent, `onModuleInit`)

```typescript
import { HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

try {
  await internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
} catch {
  await internalClient.send(new CreateBucketCommand({ Bucket: bucket }));
}
```

### Multipart upload (TD-02)

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { UploadId } = await internalClient.send(
  new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: mimeType }),
);

const partUrl = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: n }),
  { expiresIn: uploadUrlTtlSeconds },
);
// client PUTs the part body to partUrl and reads back the `ETag` response header

await internalClient.send(
  new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId,
    MultipartUpload: { Parts: parts.map(({ partNumber, eTag }) => ({ PartNumber: partNumber, ETag: eTag })) },
  }),
);
```

### Presigned GET for stream/download/thumbnail (TD-05)

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(
  publicClient,
  new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: forDownload ? `attachment; filename="${originalFilename}"` : undefined,
    ResponseContentType: mimeType,
  }),
  { expiresIn: playbackUrlTtlSeconds },
);
// controller responds 302 with Location: url — the client's own Range header reaches MinIO/S3 directly
```

### Worker-side plain object operations

```typescript
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

await internalClient.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: thumbnailBuffer, ContentType: 'image/jpeg' }));

const { Body } = await internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: originalKey }));
// Body is a Node.js Readable in the Node runtime — piped to a temp file for ffprobe/ffmpeg to read
```

---

## ffmpeg / ffprobe (no npm wrapper — see TD-03)

**Source:** npm registry page for `fluent-ffmpeg` (fetched) shows the package **deprecated**. No library added; `FfmpegService` shells out to the `ffmpeg`/`ffprobe` binaries directly via `node:child_process.execFile`, with the binaries installed through `apt-get install -y ffmpeg` in the shared `Dockerfile.dev` (SI-03.1) — `ffmpeg` on Debian/Ubuntu pulls in `ffprobe` as part of the same package. No context7/version pin applies since no npm package is added.
