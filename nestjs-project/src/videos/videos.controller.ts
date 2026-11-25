import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { PublicVideoResponseDto } from './dto/public-video-response.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(201)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video and an S3 multipart upload, returning a presigned URL for each part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    type: VideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'No channel found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/uploads/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the S3 multipart upload, transitions the video to processing, and enqueues background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is now processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video doesn't exist or doesn't belong to the caller",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Storage rejected the multipart completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List my videos',
    description:
      "Returns every video belonging to the caller's channel, any status, newest first.",
  })
  @ApiResponse({
    status: 200,
    description: "The caller's videos",
    type: [VideoResponseDto],
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOwnVideos(
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoResponseDto[]> {
    return this.videosService.findOwnVideos(user.sub);
  }

  @Public()
  @Get(':id')
  @ApiOperation({
    summary: 'Get a public video',
    description: 'Returns video metadata — only for videos that are ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    type: PublicVideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Video doesn't exist or is not ready",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findPublicVideo(
    @Param('id') id: string,
  ): Promise<PublicVideoResponseDto> {
    return this.videosService.findPublicVideo(id);
  }

  @Public()
  @Get(':id/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a presigned storage URL for inline playback (supports byte-range requests).',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const url = await this.videosService.getStreamRedirectUrl(id);
    res.redirect(302, url);
  }

  @Public()
  @Get(':id/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned storage URL with a Content-Disposition: attachment header.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const url = await this.videosService.getDownloadRedirectUrl(id);
    res.redirect(302, url);
  }

  @Public()
  @Get(':id/thumbnail')
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description: 'Redirects to a presigned storage URL for the thumbnail.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video is not ready, or has no thumbnail yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getThumbnailRedirectUrl(id);
    res.redirect(302, url);
  }
}
