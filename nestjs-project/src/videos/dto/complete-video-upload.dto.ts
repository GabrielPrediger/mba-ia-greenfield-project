import { Type } from 'class-transformer';
import { ArrayMinSize, ValidateNested } from 'class-validator';
import { CompletedPartDto } from './completed-part.dto';

export class CompleteVideoUploadDto {
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  @ArrayMinSize(1)
  parts: CompletedPartDto[];
}
