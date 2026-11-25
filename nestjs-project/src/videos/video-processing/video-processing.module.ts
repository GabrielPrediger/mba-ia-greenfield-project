import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from '../entities/video.entity';
import { VideoProcessor } from './video.processor';
import { StorageModule } from '../../storage/storage.module';
import { FfmpegModule } from '../../ffmpeg/ffmpeg.module';
import { UsersModule } from '../../users/users.module';
import { VIDEO_PROCESSING_QUEUE } from '../queues/video-processing.queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    FfmpegModule,
    // Channel (and, transitively via UsersModule, User) entity metadata must
    // be loaded wherever Video's @ManyToOne(() => Channel) relation is
    // resolved, even though the processor never calls ChannelsService or
    // UsersService directly — without this, TypeORM fails at boot with
    // "Entity metadata for Video#channel was not found" / "Channel#user was
    // not found" (both confirmed locally against a real Postgres instance).
    UsersModule,
  ],
  providers: [VideoProcessor],
})
export class VideoProcessingModule {}
