import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService } from '../../ffmpeg/ffmpeg.service';
import { VIDEO_PROCESSING_QUEUE } from '../queues/video-processing.queue';
import type { VideoProcessingJobData } from '../queues/video-processing.queue';
import { buildThumbnailKey } from '../storage-keys.util';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.dataSource.manager.findOneByOrFail(Video, {
      id: videoId,
    });

    // Idempotency guard: a prior attempt may have completed successfully and
    // reached `ready` even if BullMQ never recorded the job as finished (a
    // crash between the final `save` and the ack). Re-running a finished job
    // from scratch would re-download/re-process for nothing and could
    // overwrite a good thumbnail_key with a different one, so treat anything
    // other than `processing` as already handled.
    if (video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Video ${videoId} is not in processing status (status: ${video.status}) — skipping as a no-op`,
      );
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const originalPath = join(workDir, `original-${randomUUID()}`);
    const thumbnailPath = join(workDir, `thumbnail-${randomUUID()}.jpg`);

    try {
      await this.storageService.downloadToFile(video.storage_key, originalPath);

      const metadata = await this.ffmpegService.extractMetadata(originalPath);

      const thumbnailAtSeconds = Math.min(2, metadata.durationSeconds * 0.1);
      await this.ffmpegService.generateThumbnail(
        originalPath,
        thumbnailPath,
        thumbnailAtSeconds,
      );

      const thumbnailKey = buildThumbnailKey(video.channel_id, video.id);
      const thumbnailBuffer = await readFile(thumbnailPath);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.status = VideoStatus.READY;
      video.duration_seconds = Math.round(metadata.durationSeconds);
      video.metadata = {
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        bitrate: metadata.bitrate,
        frameRate: metadata.frameRate,
      };
      video.thumbnail_key = thumbnailKey;
      await this.dataSource.manager.save(Video, video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData>, error: Error) {
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);

    if (!isFinalAttempt) {
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} processing failed permanently after ${job.attemptsMade} attempts: ${error.message}`,
    );

    try {
      await this.dataSource.manager.update(Video, job.data.videoId, {
        status: VideoStatus.ERROR,
        error_message: error.message,
      });
    } catch (updateError) {
      // Event handler context: log without rethrowing (rethrowing here would
      // crash the worker process rather than retry the job).
      this.logger.error(
        `Failed to persist error status for video ${job.data.videoId}`,
        updateError instanceof Error ? updateError.stack : updateError,
      );
    }
  }
}
