import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import type { ConfigType } from '@nestjs/config';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { PublicVideoResponseDto } from './dto/public-video-response.dto';
import {
  VIDEO_PROCESSING_QUEUE,
  PROCESS_VIDEO_JOB,
  VideoProcessingJobData,
} from './queues/video-processing.queue';
import {
  VideoNotFoundException,
  VideoNotInDraftStatusException,
  VideoUploadCompletionFailedException,
} from '../common/exceptions/domain.exception';
import { buildOriginalKey } from './storage-keys.util';

function extractExtension(mimeType: string, filename: string): string {
  const subtype = mimeType.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '');
  if (subtype) {
    return subtype.toLowerCase();
  }
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : 'bin';
}

@Injectable()
export class VideosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessingJobData>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);

    const videoId = randomUUID();
    const extension = extractExtension(dto.mimeType, dto.filename);
    const storageKey = buildOriginalKey(channel.id, videoId, extension);

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.mimeType,
    );

    await this.dataSource.manager.save(
      this.dataSource.manager.create(Video, {
        id: videoId,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        mime_type: dto.mimeType,
        size_bytes: String(dto.sizeBytes),
        storage_key: storageKey,
        upload_id: uploadId,
      }),
    );

    const partSize = this.config.uploadPartSizeBytes;
    const totalParts = Math.max(1, Math.ceil(dto.sizeBytes / partSize));

    const parts = await Promise.all(
      Array.from({ length: totalParts }, (_, index) => index + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.presignUploadPartUrl(
            storageKey,
            uploadId,
            partNumber,
            this.config.uploadUrlTtlSeconds,
          ),
        }),
      ),
    );

    return {
      id: videoId,
      uploadId,
      storageKey,
      partSize,
      parts,
    };
  }

  async findById(videoId: string): Promise<Video> {
    const video = await this.dataSource.manager.findOne(Video, {
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = await this.findById(videoId);

    if (video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftStatusException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        dto.parts,
      );
    } catch {
      throw new VideoUploadCompletionFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.dataSource.manager.save(Video, video);

    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    return VideoResponseDto.fromEntity(video);
  }

  async findOwnVideos(userId: string): Promise<VideoResponseDto[]> {
    const channel = await this.channelsService.findByUserId(userId);
    const videos = await this.dataSource.manager.find(Video, {
      where: { channel_id: channel.id },
      order: { created_at: 'DESC' },
    });
    return videos.map((video) => VideoResponseDto.fromEntity(video));
  }

  async findPublicVideo(videoId: string): Promise<PublicVideoResponseDto> {
    const video = await this.findReadyVideo(videoId);
    return PublicVideoResponseDto.fromEntity(video);
  }

  async getStreamRedirectUrl(videoId: string): Promise<string> {
    const video = await this.findReadyVideo(videoId);
    return this.storageService.presignGetUrl(video.storage_key, {
      responseContentType: video.mime_type,
      ttlSeconds: this.config.playbackUrlTtlSeconds,
    });
  }

  async getDownloadRedirectUrl(videoId: string): Promise<string> {
    const video = await this.findReadyVideo(videoId);
    return this.storageService.presignGetUrl(video.storage_key, {
      responseContentDisposition: `attachment; filename="${video.original_filename}"`,
      responseContentType: video.mime_type,
      ttlSeconds: this.config.playbackUrlTtlSeconds,
    });
  }

  async getThumbnailRedirectUrl(videoId: string): Promise<string> {
    const video = await this.findReadyVideo(videoId);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetUrl(video.thumbnail_key, {
      responseContentType: 'image/jpeg',
      ttlSeconds: this.config.playbackUrlTtlSeconds,
    });
  }

  private async findReadyVideo(videoId: string): Promise<Video> {
    const video = await this.findById(videoId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
