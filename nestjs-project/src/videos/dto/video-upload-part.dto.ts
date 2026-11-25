import { ApiProperty } from '@nestjs/swagger';

export class VideoUploadPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example: 'https://storage.example.com/videos/...&X-Amz-Signature=...',
  })
  url: string;
}
