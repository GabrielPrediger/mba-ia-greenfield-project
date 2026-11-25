import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegService } from './ffmpeg.service';

const FIXTURE_PATH = join(__dirname, '..', '..', 'test/fixtures/sample.mp4');

describe('FfmpegService (integration — real ffmpeg/ffprobe binaries)', () => {
  let service: FfmpegService;
  let workDir: string;

  beforeAll(async () => {
    service = new FfmpegService();
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-service-spec-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('extractMetadata returns the real duration and dimensions of the fixture video', async () => {
    const metadata = await service.extractMetadata(FIXTURE_PATH);

    expect(metadata.durationSeconds).toBeGreaterThanOrEqual(1.5);
    expect(metadata.durationSeconds).toBeLessThanOrEqual(2.5);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.codec).toBe('h264');
    expect(metadata.frameRate).toBeGreaterThan(0);
  });

  it('generateThumbnail produces a non-empty JPEG file', async () => {
    const outputPath = join(workDir, 'thumb.jpg');

    await service.generateThumbnail(FIXTURE_PATH, outputPath, 1);

    const stats = await stat(outputPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('extractMetadata rejects for a non-video file instead of returning a fabricated result', async () => {
    const garbagePath = join(workDir, 'not-a-video.txt');
    await writeFile(garbagePath, 'this is definitely not a video file');

    await expect(service.extractMetadata(garbagePath)).rejects.toThrow();
  });

  it('generateThumbnail rejects for a non-video file', async () => {
    const garbagePath = join(workDir, 'not-a-video-2.txt');
    await writeFile(garbagePath, 'also not a video');
    const outputPath = join(workDir, 'should-not-exist.jpg');

    await expect(
      service.generateThumbnail(garbagePath, outputPath, 0),
    ).rejects.toThrow();
  });
});
