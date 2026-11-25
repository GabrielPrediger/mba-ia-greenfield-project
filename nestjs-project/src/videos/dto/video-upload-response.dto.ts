import { ApiProperty } from '@nestjs/swagger';
import { VideoUploadPartDto } from './video-upload-part.dto';

export class VideoUploadResponseDto {
  @ApiProperty({
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: '2~AbCdEfGhIjKlMnOpQrStUvWxYz' })
  uploadId: string;

  @ApiProperty({
    example:
      'videos/f47ac10b-58cc-4372-a567-0e02b2c3d479/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/original.mp4',
  })
  storageKey: string;

  @ApiProperty({ example: 104857600 })
  partSize: number;

  @ApiProperty({ type: [VideoUploadPartDto] })
  parts: VideoUploadPartDto[];
}
