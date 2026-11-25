# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos / Storage / Queue

### Module

`VideosModule` (`src/videos/`) owns the video upload/playback lifecycle. Endpoints:

| Method & Path                         | Auth      | Purpose                                                              |
|----------------------------------------|-----------|-----------------------------------------------------------------------|
| `POST /videos/uploads`                 | required  | Create a draft video + S3 multipart upload; returns a presigned URL per part |
| `POST /videos/:id/uploads/complete`    | required  | Complete the multipart upload, move to `processing`, enqueue a job    |
| `GET /videos`                          | required  | List the caller's own videos, every status                            |
| `GET /videos/:id`                      | `@Public` | Public video metadata — only for `status: 'ready'`                    |
| `GET /videos/:id/stream`               | `@Public` | 302 to a presigned inline-playback URL (supports byte ranges)         |
| `GET /videos/:id/download`             | `@Public` | 302 to a presigned URL with `Content-Disposition: attachment`         |
| `GET /videos/:id/thumbnail`            | `@Public` | 302 to a presigned URL for the generated thumbnail                    |

Upload part size, max upload size, and presigned-URL TTLs are all configurable — see env vars below.

### Video Status Lifecycle

```
draft → processing → ready
                   ↘ error
```

- `draft` — row created by `initiateUpload`; the multipart upload is open but not yet completed.
- `processing` — `completeUpload` succeeded against storage; a job is enqueued; the public read endpoints 404 until `ready`.
- `ready` — `VideoProcessor` finished: `duration_seconds`, `metadata` (width/height/codec/bitrate/frameRate), and `thumbnail_key` are set.
- `error` — `VideoProcessor` exhausted all configured BullMQ attempts; `error_message` is set. A video never moves out of `error` automatically.

`VideoProcessor#process` is idempotent: it no-ops if the video isn't `processing` when the job runs, so a retried/replayed job after a crash can't reprocess or corrupt an already-`ready` (or already-failed) video.

### StorageModule and the Internal/Public Endpoint Split (TD-05)

`StorageModule` (`src/storage/`) wraps `@aws-sdk/client-s3` against MinIO (or S3 in production). It holds **two** `S3Client` instances:

- `internalClient` — built from `STORAGE_ENDPOINT` (the Docker service name, e.g. `http://minio:9000`). Used for every direct SDK call made from inside the API/worker containers (`createMultipartUpload`, `completeMultipartUpload`, `putObject`, `downloadToFile`, bucket bootstrap).
- `publicClient` — built from `STORAGE_PUBLIC_ENDPOINT` (a host/browser-reachable address). Used **only** to presign URLs (`presignUploadPartUrl`, `presignGetUrl`) that are handed back to a caller — a browser or external client can never resolve the Docker-internal `minio` hostname, so presigned URLs must be signed against the externally-reachable endpoint even though the signing call itself happens inside the container.

Never presign a URL with `internalClient`, and never make a direct (non-presigned) SDK call with `publicClient`.

### The `nestjs-worker` Service

Video processing (FFmpeg metadata extraction + thumbnail generation) runs in a separate process from the HTTP API:

- `src/worker/worker.module.ts` + `src/worker/main.ts` — a `NestFactory.createApplicationContext` (no HTTP server) that imports only `VideoProcessingModule`. It has no `AuthModule`/`ThrottlerModule`/guards — there's no inbound request to guard.
- Compose service: `nestjs-worker`, running `npm run start:worker:dev` (`start:worker:prod` in production), built from the same `Dockerfile.dev`/image as `nestjs-api`.
- Observe it with `docker compose logs nestjs-worker` (or `docker compose logs -f nestjs-worker` to follow).
- It consumes `VIDEO_PROCESSING_QUEUE` jobs enqueued by `VideosService#completeUpload`, via `VideoProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)` / `WorkerHost`).

Any module that registers the `Video` entity must transitively have `Channel` (and `Channel`'s own `User` relation) registered somewhere in the same module graph, or TypeORM throws `Entity metadata for Video#channel was not found` at `DataSource.initialize()` — this is why `VideoProcessingModule` imports `UsersModule` even though `VideoProcessor` never calls `UsersService`/`ChannelsService` directly.

### Env Vars

| Var                              | Purpose                                                             |
|-----------------------------------|----------------------------------------------------------------------|
| `STORAGE_ENDPOINT`                 | S3/MinIO endpoint for direct (internal) SDK calls                   |
| `STORAGE_PUBLIC_ENDPOINT`          | S3/MinIO endpoint used when presigning URLs handed back to clients  |
| `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET` | Standard S3 client config |
| `VIDEO_UPLOAD_PART_SIZE_BYTES`     | Multipart upload chunk size (default 100MB; S3/MinIO reject any part but the last under 5MiB) |
| `VIDEO_UPLOAD_MAX_SIZE_BYTES`      | Max total upload size (default 10GB)                                 |
| `VIDEO_UPLOAD_URL_TTL_SECONDS`     | TTL for presigned upload-part URLs                                   |
| `VIDEO_PLAYBACK_URL_TTL_SECONDS`   | TTL for presigned stream/download/thumbnail URLs                     |
| `REDIS_HOST`, `REDIS_PORT`         | BullMQ connection (`VIDEO_PROCESSING_QUEUE`)                         |

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
