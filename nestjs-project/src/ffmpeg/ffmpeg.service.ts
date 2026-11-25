import { Injectable } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { VideoMetadata } from '../videos/entities/video-metadata.type';

const execFile = promisify(execFileCallback);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

function parseFrameRate(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 0;
  const [num, den] = rFrameRate.split('/').map(Number);
  if (!den) return num || 0;
  return num / den;
}

export interface VideoMetadataWithDuration extends VideoMetadata {
  durationSeconds: number;
}

@Injectable()
export class FfmpegService {
  async extractMetadata(filePath: string): Promise<VideoMetadataWithDuration> {
    const { stdout } = await execFile('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );

    if (!videoStream) {
      throw new Error(`No video stream found in "${filePath}"`);
    }

    const durationSeconds = parseFloat(parsed.format?.duration ?? '0');

    return {
      durationSeconds,
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      codec: videoStream.codec_name ?? 'unknown',
      bitrate: parseInt(
        videoStream.bit_rate ?? parsed.format?.bit_rate ?? '0',
        10,
      ),
      frameRate: parseFrameRate(videoStream.r_frame_rate),
    };
  }

  async generateThumbnail(
    filePath: string,
    outputPath: string,
    atSeconds: number,
  ): Promise<void> {
    await execFile('ffmpeg', [
      '-y',
      '-ss',
      String(Math.max(0, atSeconds)),
      '-i',
      filePath,
      '-vframes',
      '1',
      outputPath,
    ]);
  }
}
