import { ApiProperty } from '@nestjs/swagger';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../entities/video-status.enum';
import { VideoMetadata } from '../entities/video-metadata.type';

export class VideoResponseDto {
  @ApiProperty({
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: 'My vacation video' })
  title: string;

  @ApiProperty({
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    format: 'uuid',
  })
  channelId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;

  @ApiProperty({ required: false, nullable: true, example: null })
  durationSeconds: number | null;

  @ApiProperty({ required: false, nullable: true, example: null })
  metadata: VideoMetadata | null;

  @ApiProperty({ required: false, nullable: true, example: null })
  errorMessage: string | null;

  @ApiProperty({ example: '2026-11-25T12:00:00.000Z' })
  createdAt: Date;

  static fromEntity(video: Video): VideoResponseDto {
    const dto = new VideoResponseDto();
    dto.id = video.id;
    dto.title = video.title;
    dto.channelId = video.channel_id;
    dto.status = video.status;
    dto.durationSeconds = video.duration_seconds;
    dto.metadata = video.metadata;
    dto.errorMessage = video.error_message;
    dto.createdAt = video.created_at;
    return dto;
  }
}
