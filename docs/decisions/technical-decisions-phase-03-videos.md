---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-25
scope_description: "Upload and background processing of video files: object storage usage, background job queue, large-file upload strategy (up to 10GB), the video worker (metadata extraction + thumbnail generation via FFmpeg), unique URL and streaming/download strategy, and the video status lifecycle including failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload initiation, upload completion, metadata, streaming, download, thumbnail), the new `StorageModule` (S3/MinIO client), the BullMQ queue producer, and a new standalone worker process that consumes the queue and runs FFmpeg/ffprobe.
- `next-frontend/` — out of scope per the assignment ("Este é um desafio de backend... a interface de vídeo não faz parte do escopo desta fase").

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Fila de processamento em segundo plano e um worker que a consome

**Context:** `docs/project-plan.md` and the C4 diagram (`docs/diagrams/software-arch.mermaid`) both list the Message Queue as "TBD" — this is the one genuinely open stack decision of the phase. The queue must decouple video upload completion from processing (metadata extraction + thumbnail), support retries with backoff, and allow a dedicated worker process to consume jobs. No queue infrastructure exists yet in `compose.yaml` (only `db` and `mailpit`).

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue library, first-class NestJS integration via `@nestjs/bullmq`. Each queue is a set of Redis sorted sets/lists; a `Worker` process polls via blocking Redis commands (no polling overhead). Supports delayed jobs, per-job retry count with configurable backoff (`fixed` or `exponential`), job events (`completed`, `failed`, `progress`), and a `Queue` object for producers plus a `Processor`/`WorkerHost` for consumers.
- **Pros:** Official NestJS wrapper (`@nestjs/bullmq`) gives DI-friendly `@InjectQueue()` / `@Processor()` decorators matching the project's existing module conventions. Redis is lightweight (single binary, ~15MB image), trivial to add to `compose.yaml`, and is a very common piece of infra the team is likely to reuse later (caching, rate-limit store). Built-in exponential backoff and a `failed` job set that doubles as a dead-letter view (failed jobs are retained with their stack trace and attempt count, inspectable via `queue.getJobs(['failed'])` — this is the project's de facto DLQ, consistent with how `.claude`'s own outbox-pattern precedent in Phase "Design Docs" reasoned about retry + DLQ). Mature, actively maintained (BullMQ, not the deprecated `Bull`), large community, good TypeScript types.
- **Cons:** Introduces Redis as new infra (acceptable — the assignment explicitly expects "fila, worker e storage reais subindo no Compose"). Redis persistence (AOF/RDB) must be configured deliberately or a Redis restart during processing can lose in-flight job state — acceptable for a course project with a single-node Redis and `appendonly yes` is enough. Not a durable broker in the RabbitMQ/Kafka sense — fine for this workload (one job type, single queue, not fan-out/pub-sub).

### Option B: RabbitMQ (AMQP)
- Full message broker with exchanges, durable queues, and acknowledgements. NestJS has first-class microservice transport support (`@nestjs/microservices` RMQ transport).
- **Pros:** Durable queues survive broker restarts by design. Mature dead-letter-exchange (DLX) primitive is a named first-class concept, not a side effect of a "failed" set. Battle-tested at scale for fan-out/pub-sub workloads.
- **Cons:** Heavier operationally (dedicated management plane, ~200MB+ image, exchange/queue/binding setup is more ceremony for a single job type). NestJS's RMQ microservice transport is designed around request/response or event patterns, not "enqueue a background job with retries and backoff" — that part would have to be hand-rolled on top of raw AMQP (retry counters in message headers, manual backoff via a delay exchange). For a single job type with no fan-out requirement, this is materially more code for no corresponding benefit here.

### Option C: pg-boss (PostgreSQL-backed queue, no new infra)
- Queue implemented entirely on top of the existing PostgreSQL database using `SKIP LOCKED` polling — no new service to run.
- **Pros:** Zero new infrastructure — reuses the `db` service already in `compose.yaml`. Transactional enqueue (can enqueue the job in the same transaction that flips the video to `processing`), which eliminates a narrow dual-write race that BullMQ/Redis cannot close without an outbox.
- **Cons:** The assignment explicitly frames the queue as a new piece of infrastructure to stand up and exercise in Compose ("Fila, worker e storage reais subindo no Compose" / the architecture diagram already reserves a dedicated Message Queue container distinct from the Database container) — picking a zero-new-infra option would under-deliver on the stated intent of the phase and the target architecture. Polling-based (even with `SKIP LOCKED`) has higher latency than Redis's blocking pop and adds load to the same Postgres instance serving the API.

**Recommendation:** **Option A (BullMQ + Redis)** — matches the target architecture (a distinct Message Queue container), has the lowest operational weight of the two "real new infra" options, and has first-class NestJS DI integration that fits the project's existing module conventions (`@InjectQueue`, `@Processor`). The dual-write race Option C would have closed transactionally is mitigated here by only enqueueing the job *after* the multipart upload is confirmed complete (SI-03.5) and by making the worker idempotent on `videoId` (re-processing a video that is already `ready` is a no-op guard at the top of `process()`), which is sufficient for this phase's scope.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API process must accept video files up to 10GB without buffering the whole file in memory or holding an HTTP connection open for the whole transfer (the assignment calls out "passar o arquivo de 10GB pela API de forma que trave o sistema" as automatic failure). The object storage is fixed to an S3-compatible service (MinIO locally, S3 in production per `docs/project-plan.md`), which exposes a native multipart upload API designed exactly for this problem.

**Options:**

### Option A: S3 Multipart Upload via per-part presigned URLs
- The API creates a multipart upload (`CreateMultipartUpload`), computes a part plan (fixed part size, last part remainder), and returns one presigned `UploadPart` URL per part to the client. The client (or, in this phase's testing, the e2e test acting as the client) `PUT`s each part directly to MinIO/S3 — no bytes transit the NestJS process. After all parts succeed, the client calls the API's `complete` endpoint with the returned ETags; the API calls `CompleteMultipartUpload` server-side.
- **Pros:** Zero bytes of the video body ever touch the API process — the API's memory/CPU footprint is identical whether the file is 10MB or 10GB. Native S3/MinIO feature, no custom chunking protocol to invent or maintain. Parts can be retried individually (a failed 100MB part retries in isolation, not the whole 10GB). Directly matches the assignment's own hint ("upload direto ao storage via URL pré-assinada / multipart, em vez de passar o arquivo pela API").
- **Cons:** Multipart has a minimum part size of 5MB (except the last part) and a 10,000-part ceiling — at a 100MB part size, 10GB is only ~100 parts, comfortably under the limit, but the part-size constant must be chosen deliberately. The client is responsible for orchestrating part upload and retry, which is more client-side logic than a single `PUT` (acceptable here — this phase's "client" for verification purposes is the e2e test itself, and a future frontend would use an existing multipart-upload helper library).

### Option B: Single presigned PUT URL (no multipart)
- The API presigns one `PutObject` URL for the whole file; the client performs a single `PUT` with the entire body.
- **Pros:** Much simpler client logic — one request, no part bookkeeping, no `complete` step.
- **Cons:** A single presigned PUT is an all-or-nothing transfer: a connection drop at byte 9.9GB restarts the whole upload from zero. S3-compatible services also cap a single `PutObject` body at 5GB — strictly insufficient for this phase's 10GB requirement. Disqualified on that ceiling alone.

### Option C: Stream the upload through the NestJS API (multipart/form-data, streamed to storage)
- The client `POST`s the file as `multipart/form-data` directly to the API; the API streams the incoming request body straight through to a `PutObject`/multipart call against MinIO without buffering to disk.
- **Pros:** Single endpoint, no presigned-URL plumbing, works with plain `<input type="file">` + `fetch` with no client-side orchestration.
- **Cons:** Every byte of a 10GB upload still passes through the API process and consumes an HTTP connection/worker for the full transfer duration — exactly the "segurar a API durante o envio" failure mode the assignment calls out as the wrong path, even if memory is kept flat via streaming (Node's single-threaded event loop and the API's connection pool are still occupied proportionally to transfer time, and horizontal scaling of the API now has to account for long-held upload connections). Disqualified by the assignment's explicit guidance.

**Recommendation:** **Option A (S3 multipart via per-part presigned URLs)** — the only option that is both within the 10GB requirement and keeps the API decoupled from upload bandwidth/duration, and it is explicitly the strategy the assignment's own hints point to.

**Decision:** A (S3 Multipart Upload via per-part presigned URLs)

**Part size:** Fixed 100MB parts (`VIDEO_UPLOAD_PART_SIZE_BYTES`), last part holding the remainder. At 10GB this is 100 parts — far under the 10,000-part S3/MinIO ceiling, and each part is large enough to stay well above the 5MB minimum even for small files (a sub-100MB file is a single "last" part).

---

## TD-03: Worker Execution Model and Metadata/Thumbnail Extraction

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Metadata extraction and thumbnail generation are CPU-bound, potentially slow operations (seconds for a short clip, much longer for a large file) that must never run inside the HTTP request/response cycle, and must not share a process with the API so that a stuck/slow FFmpeg invocation cannot starve the Node.js event loop that serves HTTP traffic.

**Options:**

### Option A: Separate OS process — standalone NestJS application context, own container
- A second entrypoint (`src/worker/main.ts`) boots a dedicated `WorkerModule` via `NestFactory.createApplicationContext()` (no HTTP listener). It registers the BullMQ `Processor`/`WorkerHost` that consumes the `video-processing` queue. It runs in its own `nestjs-worker` Docker Compose service (same image/Dockerfile as the API, different `command`), so it scales and fails independently of the HTTP API. FFmpeg/ffprobe binaries are installed in the shared image; the worker shells out to them (via `fluent-ffmpeg`) against a temp file downloaded from storage.
- **Pros:** True process isolation — a wedged FFmpeg invocation cannot block API request handling, and the worker can be scaled (more replicas) or restarted independently. Matches the target C4 architecture exactly (a distinct "Video Worker (FFmpeg)" container). Reuses 100% of the existing module/DI conventions (`@Processor` is just another injectable class), so the project's established patterns (repository pattern, domain exceptions, config namespaces) carry over unchanged.
- **Cons:** A second `main.ts`/Dockerfile command to maintain, and the worker's own module graph (`WorkerModule`) must be assembled carefully so it does *not* pull in HTTP-only providers (controllers, `ThrottlerModule`, etc.) it doesn't need.

### Option B: In-process background processing (same Nest application, `@Processor` registered in `AppModule`)
- The API and the queue consumer run in the same Node.js process; the HTTP server and the BullMQ `Worker` share the event loop.
- **Pros:** Simpler deployment — one container, one `main.ts`, nothing new to wire for process bootstrapping.
- **Cons:** Directly violates the isolation goal: FFmpeg's child-process spawn happens on the same event loop that is also serving HTTP requests, so heavy or numerous concurrent processing jobs degrade API latency. Cannot scale API replicas and worker concurrency independently (every API replica would also run a full worker, coupling the two scaling dimensions). Does not match the target architecture, which reserves a distinct Video Worker container.

### Option C: Worker as a separate language/runtime service (e.g., a Python microservice wrapping FFmpeg)
- A dedicated non-Node service (e.g., Python + `ffmpeg-python`) consumes the same Redis-backed queue.
- **Pros:** Could lean on a richer media-processing ecosystem if requirements grew substantially (transcoding ladders, HDR, etc. — none of which this phase needs).
- **Cons:** Introduces a second runtime/toolchain, a second dependency-management surface, and a second set of project conventions (testing, linting, CLAUDE.md) for a phase whose actual processing need (ffprobe duration/metadata + one `ffmpeg` thumbnail frame) is trivially expressible via a thin Node wrapper. Unjustified complexity for the scope of this phase.

**Recommendation:** **Option A (separate process / separate Compose service, same NestJS/Node stack)** — delivers real process isolation and matches the target architecture, at the lowest additional-toolchain cost (reuses the existing Node/Nest/Docker image and conventions).

**Decision:** A (Separate OS process — standalone NestJS application context, own `nestjs-worker` Compose service)

**Metadata/thumbnail tool:** `ffprobe` (JSON output, `-print_format json -show_format -show_streams`) for duration + codec/resolution/bitrate/framerate metadata; `ffmpeg` with a single `-vframes 1` extraction at `min(2s, duration * 0.1)` for the thumbnail frame (avoids grabbing a black/blank first frame common to many encoders' first GOP), encoded as JPEG.

**Library note (checked during research, not just assumed):** the obvious npm wrapper, `fluent-ffmpeg`, is marked **deprecated** on its npm registry page as of this research pass — adding a deprecated dependency to a greenfield module is a worse trade than the thin wrapper it would have saved. `FfmpegService` instead wraps `node:child_process` (`execFile`) directly against the `ffmpeg`/`ffprobe` binaries (installed via `apt-get` in the shared Docker image — see SI-03.1): one call builds the `ffprobe` argument array and parses its JSON stdout, another builds the `ffmpeg` thumbnail argument array. This keeps the same testable boundary a wrapper library would have given (the worker's tests mock/exercise `FfmpegService` as a single injectable provider, per the project's mock-boundary testing principle) without taking on an unmaintained dependency.

---

## TD-04: Unique URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a stable, conflict-free public identifier to build its watch/stream/download/thumbnail URLs from.

**Options:**

### Option A: Database-generated UUID (v4) as the video's primary key, used directly in the URL
- `PrimaryGeneratedColumn('uuid')` on the `Video` entity (the same pattern already used by every other entity in the project — `User`, `Channel`, `RefreshToken`). URLs are `/videos/:id/...` where `:id` is that UUID.
- **Pros:** Zero collision probability by construction (122 random bits) — no pre-check query, no retry loop, no uniqueness race to guard against (unlike the `Channel.nickname` generator, which needed a retry-with-savepoint loop specifically because human-readable nicknames collide). Perfectly consistent with every other entity in the codebase — no new ID strategy to learn or document. The same id doubles as the S3 object-key namespace component (`videos/{channelId}/{videoId}/original.<ext>`), so "unique URL" and "unique storage key" fall out of the same identifier for free.
- **Cons:** Not human-readable or SEO-friendly (acceptable — the assignment does not ask for vanity/slug URLs, and the frontend, out of scope for this phase, is free to layer a `title`-derived slug purely for display later without changing the canonical id).

### Option B: Human-readable slug derived from the title (e.g., `my-video-title-ab12cd`)
- Mirrors `ChannelsService`'s nickname-generation pattern: sanitize the title, append a random/disambiguating suffix, pre-check + retry on collision.
- **Pros:** Prettier, shareable URLs.
- **Cons:** Reintroduces exactly the collision-retry complexity (`nickname.util.ts` + `MAX_RETRIES` + savepoints) that `Channel` needed purely because its identifier is derived from unreliable human input — there is no requirement in this phase asking for readable URLs, so this would be speculative complexity with a real collision-handling cost and no stated benefit.

### Option C: Short hash (e.g., base62-encoded 8 chars) as a secondary public id, separate from the internal PK
- Add a second column purely for the public-facing id.
- **Pros:** Shorter URLs than a full UUID.
- **Cons:** Two identifiers for the same row (internal PK + public id) is an extra field, an extra uniqueness index, and an extra "which one do I use where" decision sprinkled through the codebase, for a cosmetic shortening with no functional requirement behind it.

**Recommendation:** **Option A (UUID primary key used directly as the URL id)** — consistent with every existing entity, zero collision-handling code, and it directly doubles as the storage-key namespace.

**Decision:** A (UUID v4 primary key, used directly in all video URLs)

---

## TD-05: Streaming and Download Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The player must be able to seek (HTTP Range requests, `206 Partial Content`) without downloading the whole file first, and the user must be able to download the original file. S3-compatible object storage natively serves both `GET` and ranged `GET` (`206 Partial Content`, `Accept-Ranges: bytes`) with zero extra code — the only design question is whether the NestJS API sits in the data path or merely brokers access to storage.

**Options:**

### Option A: Presigned GET URL + HTTP redirect (API never touches video bytes)
- `GET /videos/:id/stream` and `GET /videos/:id/download` validate that the video is `ready`, then return a `302 Found` with `Location` set to a short-TTL presigned `GetObject` URL (download sets `ResponseContentDisposition: attachment; filename="..."`; stream leaves it inline). The client's subsequent request — Range header included — goes straight to MinIO/S3, which natively answers `206 Partial Content`.
- **Pros:** Symmetric with the upload strategy (TD-02) — the API is never in the byte path for either direction, so its resource usage is independent of video size or concurrent streams. Zero custom Range-parsing/byte-serving code to write or test — MinIO/S3's own `GetObject` already implements `Range`/`206` correctly; the API's job is reduced to "is this video ready, and should this caller be allowed to see it," which is exactly the kind of authorization decision that belongs in the API. Short presigned TTL (5 minutes, `VIDEO_PLAYBACK_URL_TTL_SECONDS`) bounds how long a leaked URL stays useful without needing per-request revocation infrastructure.
- **Cons:** Two round-trips (API redirect, then storage fetch) instead of one — negligible for a single long-lived media connection, irrelevant next to multi-second video transfer times. The presigned URL's host must be one the end client can actually resolve, which has to be configured deliberately (see note below) rather than always matching the Docker-internal hostname the API itself uses to reach storage.

### Option B: API proxies the bytes, implementing Range passthrough itself
- `GET /videos/:id/stream` reads the `Range` header, calls `GetObject` with a matching `Range` parameter against storage, and pipes the resulting stream back to the client with a hand-written `206`/`Content-Range`/`Accept-Ranges` response.
- **Pros:** The API fully controls the response (e.g., could inject analytics, watermarking, or per-chunk authorization later); the client only ever talks to one host, sidestepping the "which hostname is the presigned URL built with" question entirely.
- **Cons:** Every streamed byte, for every concurrent viewer, now flows through the NestJS process and its connection pool — exactly the scaling coupling TD-02 rejected for uploads, mirrored on the read side. Requires hand-written, well-tested `Range` header parsing and `Content-Range` response construction (a real source of subtle bugs — off-by-one byte ranges, multi-range requests, missing `Accept-Ranges` advertisement) to reach feature parity with what storage already does correctly. Disqualified for the same architectural reason as upload Option C in TD-02.

**Recommendation:** **Option A (presigned GET redirect)** — architecturally symmetric with the upload decision, delegates all Range/206 correctness to storage (already a battle-tested implementation), and keeps the API's role limited to the authorization question it is actually responsible for.

**Decision:** A (Presigned GET URL + 302 redirect for both `stream` and `download`)

**Hostname note (dev/test environment):** The S3 client used to *sign* GET/PUT URLs must be configured with the same endpoint hostname real callers will use to resolve the request, because SigV4 binds the signature to the host the request is made against — rewriting the host after signing invalidates the signature. `STORAGE_ENDPOINT` (internal, Docker service name `minio:9000`) is used for every server-to-storage call the API/worker make directly (bucket bootstrap, `CreateMultipartUpload`, `CompleteMultipartUpload`, worker `GetObject`/`PutObject`). `STORAGE_PUBLIC_ENDPOINT` is a separate, independently configurable value used only to *sign* URLs handed to external callers (upload-part URLs, stream/download/thumbnail redirects); it defaults to the same value as `STORAGE_ENDPOINT` so the dev/test environment — where the automated test suite itself runs inside the `nestjs-api` container, i.e., on the Docker network, per this project's "every test command runs in the container" rule — resolves correctly without extra configuration. A real deployment (or a human tester hitting the API from their own browser outside Docker) overrides `STORAGE_PUBLIC_ENDPOINT` to the externally-resolvable S3/MinIO endpoint (e.g., a public MinIO console port mapping, or the real S3/CDN domain in production) without touching `STORAGE_ENDPOINT`. This is a configuration concern, not a code branch — both clients use the identical `S3Client` wrapper, parameterized only by which endpoint value they were constructed with.

---

## TD-06: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video needs an explicit, observable status column that reflects where it is in the upload → processing → ready/error pipeline, and a defined behavior for what happens when processing fails (the assignment explicitly asks for both).

**Options:**

### Option A: Four-state enum (`draft → processing → ready | error`) + BullMQ's own attempt/backoff as the retry mechanism, failed-job set as the de facto DLQ
- `status` column: `draft` (row created when upload is initiated, before any bytes exist), `processing` (multipart upload completed, job enqueued), `ready` (worker finished successfully — `duration_seconds`, `metadata`, `thumbnail_key` populated), `error` (worker exhausted all retries — `error_message` populated with the last failure's message). The BullMQ job itself is configured with `attempts: 3` and exponential backoff (`{ type: 'exponential', delay: 5000 }`); the processor lets failures propagate naturally so BullMQ's own retry bookkeeping drives re-attempts, and a `@OnWorkerEvent('failed')` listener (the sanctioned "log, don't rethrow" exception for background job handlers) checks `job.attemptsMade >= (job.opts.attempts ?? 1)` to detect the *final* failure and only then writes `status = 'error'` to the database — an intermediate failed attempt that will still be retried does not flip the row to `error` prematurely.
- **Pros:** Exactly matches the phase's own listed lifecycle (`rascunho → processando → pronto/erro`) with no extra states to invent. Retry/backoff is "for free" from the already-chosen queue technology (TD-01) — no custom retry-counter column or cron-based sweeper needed. The failed-job set is directly inspectable (`queue.getJobs(['failed'])`) for operational visibility, serving as the DLQ without a separate table.
- **Cons:** A transient worker crash mid-processing (not an explicit `throw`, e.g., the container being killed) leaves the job stuck `active` until BullMQ's stalled-job detection (`lockDuration`/`maxStalledCount`) requeues it — this is a known, documented BullMQ behavior (not a gap in this design) and does not need additional code; it's covered by BullMQ's default stalled-job recovery.

### Option B: Finer-grained status enum (e.g., separate `uploading`, `uploaded`, `extracting_metadata`, `generating_thumbnail`, `ready`, `error`)
- **Pros:** More granular progress visibility (a UI could show "generating thumbnail..." specifically).
- **Cons:** Not asked for by the assignment, which explicitly specifies the four states; every extra transition is another write + another state the worker must keep consistent if a step fails partway, with no corresponding capability requirement to justify it. Speculative generality.

### Option C: Soft-fail — on processing error, silently leave the video `processing` forever and only log
- **Pros:** Simplest to implement (no `error` state at all).
- **Cons:** Explicitly contradicts the assignment's requirement ("...e o que acontece em caso de falha no processamento" expects a defined failure behavior) and leaves the owner with no visible signal that their upload is stuck — disqualified.

**Recommendation:** **Option A (four-state enum driven by BullMQ's native retry/backoff)** — matches the assignment's literal lifecycle wording, reuses infrastructure already decided in TD-01, and needs no speculative extra states.

**Decision:** A (`draft` → `processing` → `ready` | `error`, 3 attempts with exponential backoff, final failure recorded via `OnWorkerEvent('failed')`)

---

## TD-07: Object Storage Bucket and Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage *technology* is fixed (S3-compatible — MinIO locally, S3 in production, per `docs/project-plan.md`); what this phase still has to decide is bucket layout and object-key naming, since both the original file and its generated thumbnail need a stable, collision-free location.

**Options:**

### Option A: Single bucket, hierarchical keys namespaced by channel and video id
- One bucket (`STORAGE_BUCKET`, default `videos`). Keys: `videos/{channelId}/{videoId}/original.{ext}` and `videos/{channelId}/{videoId}/thumbnail.jpg`. Bucket existence is ensured idempotently at application startup (`HeadBucket`, `CreateBucket` on 404) in `StorageService.onModuleInit`, rather than via a separate init container — this makes the dev/test environment self-healing against a fresh MinIO volume without an extra Compose service.
- **Pros:** `{channelId}/{videoId}/...` gives free, readable partitioning for any future per-channel storage-usage reporting, without needing a second bucket or a database join to answer "how much storage does this channel use." One bucket is simpler to provision, secure, and lifecycle-manage than many. Idempotent bootstrap on app start means `docker compose down -v && docker compose up` (destroying the MinIO volume) self-heals on the next API boot — no manual `mc mb` step.
- **Cons:** A single bucket means any future bucket-level policy (e.g., different retention/lifecycle rules per content type) would need prefix-based rules instead of bucket-based ones — not a requirement in this phase.

### Option B: Per-channel bucket
- One bucket created per channel (e.g., `videos-{channelId}`).
- **Pros:** Strong isolation boundary per tenant.
- **Cons:** Most S3-compatible deployments (including real AWS S3 accounts) impose a low default cap on bucket count (AWS default: 100 per account) — a growing user base would hit that ceiling. Massive operational overhead (bucket-per-tenant lifecycle, policy replication) for a requirement that doesn't ask for per-tenant storage isolation.

**Recommendation:** **Option A (single bucket, hierarchical keys)** — the readable partitioning benefit of per-channel prefixes without the operational cost and account-limit risk of per-channel buckets.

**Decision:** A (Single bucket `videos`, keys `videos/{channelId}/{videoId}/original.{ext}` and `videos/{channelId}/{videoId}/thumbnail.jpg`, idempotent bootstrap on app start)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Background Job Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Large File Upload Strategy (10GB) | S3 Multipart via presigned part URLs | A (S3 Multipart Upload via per-part presigned URLs) |
| TD-03 | Worker Execution Model | Separate process / own Compose service | A (Separate OS process, own `nestjs-worker` service) |
| TD-04 | Unique URL Strategy | UUID primary key | A (UUID v4 primary key) |
| TD-05 | Streaming and Download Strategy | Presigned GET + redirect | A (Presigned GET URL + 302 redirect) |
| TD-06 | Video Status Lifecycle and Failure Handling | 4-state enum + BullMQ retry/backoff | A (`draft→processing→ready\|error`, 3 attempts, exponential backoff) |
| TD-07 | Object Storage Bucket and Key Organization | Single bucket, hierarchical keys | A (Single bucket `videos`, `{channelId}/{videoId}/...` keys) |
