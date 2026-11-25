import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  @MinLength(1)
  eTag: string;
}
