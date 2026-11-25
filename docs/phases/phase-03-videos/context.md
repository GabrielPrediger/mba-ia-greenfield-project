---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-25T11:36:24-00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T11:52:25-00:00"
  docs/phases/phase-02-auth/context.md: "2026-11-25T11:38:03-00:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-25T11:36:24-00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Qualquer tela/UI de vídeo no `next-frontend/` (explicitamente fora do escopo pelo enunciado — "Este é um desafio de backend"). Gerenciamento de vídeos (edição de título/descrição pós-criação, exclusão, listagem pública por canal, categorias) — reservado para a Fase 04 (Gerenciamento de Vídeos e Canal). Transcodificação para múltiplas qualidades/resoluções (HLS/DASH, ABR) — não pedido pelo enunciado, que pede apenas extração de metadados + thumbnail + streaming via range requests do arquivo original.

**Deliverables:** Upload de até 10GB funcional (sem travar a API), processamento automático do vídeo (metadados + thumbnail), streaming funcionando (range requests / 206), URLs únicas geradas, download do vídeo, ciclo de status refletido no banco (`draft → processing → ready|error`).

**Affected subprojects:** `nestjs-project/` (módulo de vídeos, StorageModule, fila/worker, migration, compose.yaml).

**Deferred subprojects:** `next-frontend/` — tela de vídeo deferida explicitamente pelo enunciado (fora do escopo desta fase; não é uma lacuna identificada pelo research, é um corte de escopo declarado).

**Sequencing notes:** Depende de Fase 01 (infra base, Docker) e Fase 02 (um canal por usuário — vídeos pertencem a um canal). Fase 04 (gerenciamento de vídeos/canal) depende desta fase existir primeiro.

**Neighbors (for boundary detection only):**

- **Phase 02 (Cadastro, Login e Gerenciamento de Conta):** entrega `User`/`Channel` 1:1, guard JWT global com `@Public()` opt-out, filtro de exceções de domínio, `ValidationPipe` global, rate limiting, `class-validator`. A Fase 03 consome `Channel` como dono do vídeo e reaproveita guard/filtro/validação sem alterá-los.
- **Phase 04 (Gerenciamento de Vídeos e Canal):** consumirá a entidade `Video` e os endpoints desta fase para edição/listagem avançada — não antecipado aqui além do necessário (um endpoint simples de listagem "meus vídeos" é entregue nesta fase por ser indispensável para o próprio dono acompanhar o status do upload, mas edição/exclusão/categorização ficam para a Fase 04).

## Decisions Index

_(from `docs/decisions/technical-decisions-phase-03-videos.md`)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq, ioredis |
| phase-03-videos/TD-02 | phase | Backend | Large File Upload Strategy (10GB) | decided | A (S3 Multipart via presigned part URLs) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Worker Execution Model | decided | A (Separate OS process, own Compose service) | — |
| phase-03-videos/TD-04 | phase | Backend | Unique URL Strategy | decided | A (UUID v4 primary key) | — |
| phase-03-videos/TD-05 | phase | Backend | Streaming and Download Strategy | decided | A (Presigned GET URL + 302 redirect) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-06 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (4-state enum + BullMQ retry/backoff) | bullmq |
| phase-03-videos/TD-07 | phase | Backend | Object Storage Bucket and Key Organization | decided | A (Single bucket, hierarchical keys) | @aws-sdk/client-s3 |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-07 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

_(current-phase TDs only)_

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — matches the target architecture (a distinct Message Queue container), lowest operational weight of the "real new infra" options, first-class NestJS DI integration (`@InjectQueue`, `@Processor`/`WorkerHost`).
**Libraries:** bullmq, @nestjs/bullmq, ioredis

### phase-03-videos/TD-02

**Recommendation:** S3 Multipart Upload via per-part presigned URLs — the only option within the 10GB requirement that keeps the API decoupled from upload bandwidth/duration. Fixed 100MB parts (`VIDEO_UPLOAD_PART_SIZE_BYTES`).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** Separate OS process (standalone NestJS application context) in its own `nestjs-worker` Compose service — true process isolation from the HTTP API, matches the target C4 architecture. `ffprobe`/`ffmpeg` invoked via `node:child_process` directly (`fluent-ffmpeg` is deprecated on npm — discovered during research, not used).
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** UUID v4 primary key used directly as the URL id — zero collision probability, consistent with every other entity in the codebase, doubles as the storage-key namespace.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Presigned GET URL + 302 redirect for both stream and download — architecturally symmetric with the upload decision, delegates Range/206 correctness to storage.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-06

**Recommendation:** Four-state enum (`draft→processing→ready|error`) driven by BullMQ's own attempts/backoff; final failure recorded via `@OnWorkerEvent('failed')` comparing `job.attemptsMade` against `job.opts.attempts`.
**Libraries:** bullmq

### phase-03-videos/TD-07

**Recommendation:** Single bucket (`videos`), hierarchical keys `videos/{channelId}/{videoId}/original.{ext}` and `.../thumbnail.jpg`, idempotent bootstrap (`HeadBucket`/`CreateBucket`) on application start.
**Libraries:** @aws-sdk/client-s3

## Inherited Decisions Detail

_(inherited from phase-02-auth — directly informs this phase's error handling, validation, and auth conventions)_

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — first-class NestJS `ValidationPipe` integration; every new DTO in this phase (upload initiation, upload completion) follows this unchanged.
**Libraries:** class-validator, class-transformer

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — `{ statusCode, error, message }` response shape with machine-readable domain error codes. This phase's new domain exceptions (`VideoNotFoundException`, `VideoNotInDraftStatusException`, `VideoUploadCompletionFailedException`) extend the same `DomainException` base class and are caught by the same existing `DomainExceptionFilter` — no new filter needed.
**Libraries:** —

## Inherited Conventions

- JWT guard is registered globally (`APP_GUARD`); every new endpoint is protected by default and must explicitly opt out with `@Public()` where anonymous access is intended (the public watch/stream/download/thumbnail endpoints in this phase). _(from phase 02)_
- Domain exceptions extend `DomainException` (never throw NestJS `HttpException` subclasses from services) and are mapped to the shared `{ statusCode, error, message }` envelope by the existing `DomainExceptionFilter`. _(from phase 02)_
- Repository pattern via `TypeOrmModule.forFeature([Entity])` registered in the owning module; every entity must be registered there even with `autoLoadEntities: true`. _(from phase 02)_
- Controllers are thin — delegate to services, no `try/catch`, no business-rule conditionals. _(from phase 02)_
- Every module follows `@Module()` property order `imports → controllers → providers → exports`. _(from phase 02)_
- Config namespaces via `registerAs` + `ConfigType<typeof x>` (never `ReturnType`), injected via `@Inject(xConfig.KEY)`. _(from phase 02)_
- Migrations generated via TypeORM CLI against a running Postgres, never hand-written SQL (except where the CLI genuinely cannot express the change). _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._ (This phase has no frontend/UI scope at all — see "Out of scope" above — so there is nothing to mark non-UI or defer; the whole phase is backend-only by the assignment's own framing.)

## Testing Requirements

_(from `testing-guide-nestjs-project` skill, §3 Feature Implementation Checklist, applied to this phase's new artifact types)_

### nestjs-project

| Artifact type | Required layers |
|---|---|
| `Video` entity | Integration: constraints, defaults, enum column, FK to `channels` |
| `VideosService` (branching + DB + queue + storage) | Unit: branch logic (mock repository/queue/storage) + Integration: DB contract + queue-enqueue contract |
| `StorageService` (configured external client) | Integration: real MinIO via Docker (presign, multipart, bucket bootstrap) — **not** the testing guide's older "local filesystem" suggestion (see note below) |
| `FfmpegService` (side-effect: shells out to real binaries) | Integration: real `ffmpeg`/`ffprobe` against a committed tiny test fixture video |
| `VideoProcessor` (BullMQ consumer) | Integration: real Redis queue + real Postgres + real MinIO + real FFmpeg, asserting the full draft→processing→ready transition and the draft→processing→error transition on a deliberately corrupt fixture |
| `VideosModule` / `VideoProcessingModule` / `WorkerModule` (configured imports) | Unit: compilation test |
| `VideosController` | E2E only |
| Upload/complete-upload DTOs | E2E: one validation-wiring test per endpoint |

**Note on Object Storage test strategy (overrides `testing-guide-nestjs-project/references/external-systems.md` §"Object Storage — Local Filesystem"):** that reference predates this phase's object-storage decision being locked to S3/MinIO (`docs/project-plan.md` already fixes it; TD-07 above only decided bucket/key layout, not technology). The assignment is explicit and overriding here: *"Infra real, testada… não simule o que dá para rodar de verdade."* This phase's tests therefore exercise the real `minio` Compose service through the real `@aws-sdk/client-s3` client — not a local-filesystem adapter — which is the authoritative, traceable instruction for this phase and takes precedence over the older guide section.

### Message Queue — Real (Docker)

Per `testing-guide-nestjs-project/references/external-systems.md` §"Message Queue", now resolved by TD-01: BullMQ + the `redis` Compose service. Tests assert enqueue (producer side, `VideosService`) and consume/outcome (consumer side, `VideoProcessor`) against the real queue, per the guide's existing BullMQ example pattern.
