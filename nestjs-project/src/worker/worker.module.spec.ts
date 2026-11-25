import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { WorkerModule } from './worker.module';
import { VideoProcessor } from '../videos/video-processing/video.processor';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('WorkerModule', () => {
  it('compiles and resolves VideoProcessor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);

    await module.close();
  }, 30000);

  it('does not register any HTTP-only provider (AuthModule/ThrottlerModule are absent)', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // JwtAuthGuard and ThrottlerGuard are only ever provided by AuthModule,
    // which this worker's module graph deliberately never imports — this
    // process has no HTTP server and never receives a request to guard.
    expect(() => module.get(JwtAuthGuard)).toThrow();
    expect(() => module.get(ThrottlerGuard)).toThrow();

    await module.close();
  }, 30000);
});
