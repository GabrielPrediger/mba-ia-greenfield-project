import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;
  let workDir: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    workDir = await mkdtemp(join(tmpdir(), 'storage-service-spec-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('bucket bootstrap is idempotent — calling it twice does not throw', async () => {
    await expect(storageService.ensureBucketExists()).resolves.toBeUndefined();
    await expect(storageService.ensureBucketExists()).resolves.toBeUndefined();
  });

  it('putObject + downloadToFile round-trip the same bytes', async () => {
    const key = `test/${randomUUID()}.txt`;
    const body = Buffer.from('hello from the integration test');
    await storageService.putObject(key, body, 'text/plain');

    const destPath = join(workDir, 'downloaded.txt');
    await storageService.downloadToFile(key, destPath);

    const downloaded = await readFile(destPath);
    expect(downloaded.equals(body)).toBe(true);
  });

  it('completes a real multipart upload via presigned part URLs and real fetch PUTs', async () => {
    const key = `test/${randomUUID()}-multipart.bin`;
    const partA = Buffer.alloc(5 * 1024 * 1024, 'a'); // 5MiB — minimum non-final part size
    const partB = Buffer.alloc(1024, 'b');

    const uploadId = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    const urlA = await storageService.presignUploadPartUrl(
      key,
      uploadId,
      1,
      60,
    );
    const urlB = await storageService.presignUploadPartUrl(
      key,
      uploadId,
      2,
      60,
    );

    const responseA = await fetch(urlA, { method: 'PUT', body: partA });
    const responseB = await fetch(urlB, { method: 'PUT', body: partB });
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const eTagA = responseA.headers.get('etag') ?? '';
    const eTagB = responseB.headers.get('etag') ?? '';
    expect(eTagA.length).toBeGreaterThan(0);
    expect(eTagB.length).toBeGreaterThan(0);

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTagA },
      { partNumber: 2, eTag: eTagB },
    ]);

    const destPath = join(workDir, 'multipart-result.bin');
    await storageService.downloadToFile(key, destPath);
    const result = await readFile(destPath);
    expect(result.length).toBe(partA.length + partB.length);
  }, 30000);

  it('presignGetUrl with responseContentDisposition set produces a URL whose response carries that header', async () => {
    const key = `test/${randomUUID()}-disposition.txt`;
    await storageService.putObject(
      key,
      Buffer.from('disposition test'),
      'text/plain',
    );

    const url = await storageService.presignGetUrl(key, {
      responseContentDisposition: 'attachment; filename="renamed.txt"',
      ttlSeconds: 60,
    });

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="renamed.txt"',
    );
  });

  it('a ranged fetch against a presigned GET URL returns 206 Partial Content with the exact byte slice', async () => {
    const key = `test/${randomUUID()}-range.bin`;
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await storageService.putObject(key, body, 'application/octet-stream');

    const url = await storageService.presignGetUrl(key, { ttlSeconds: 60 });
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-99' },
    });

    expect(response.status).toBe(206);
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.length).toBe(100);
    expect(received.equals(body.subarray(0, 100))).toBe(true);
  });
});
