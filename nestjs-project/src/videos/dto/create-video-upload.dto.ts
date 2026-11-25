import { IsInt, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class CreateVideoUploadDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsString()
  @MinLength(1)
  filename: string;

  /** MIME type of the video file. Must start with "video/". */
  @IsString()
  @Matches(/^video\//)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;
}
