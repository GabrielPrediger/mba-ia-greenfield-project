import { ApiProperty } from '@nestjs/swagger';
import { Video } from '../entities/video.entity';
import { VideoMetadata } from '../entities/video-metadata.type';

export class PublicVideoResponseDto {
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

  @ApiProperty({ required: false, nullable: true, example: 120 })
  durationSeconds: number | null;

  @ApiProperty({ required: false, nullable: true, example: null })
  metadata: VideoMetadata | null;

  @ApiProperty({ example: '2026-11-25T12:00:00.000Z' })
  createdAt: Date;

  static fromEntity(video: Video): PublicVideoResponseDto {
    const dto = new PublicVideoResponseDto();
    dto.id = video.id;
    dto.title = video.title;
    dto.channelId = video.channel_id;
    dto.durationSeconds = video.duration_seconds;
    dto.metadata = video.metadata;
    dto.createdAt = video.created_at;
    return dto;
  }
}
