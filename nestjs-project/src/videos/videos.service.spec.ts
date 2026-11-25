import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import {
  VideoNotFoundException,
  VideoNotInDraftStatusException,
  VideoUploadCompletionFailedException,
} from '../common/exceptions/domain.exception';

function makeChannel(id = 'channel-id') {
  return { id, user_id: 'user-id' } as any;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-id';
  video.channel_id = 'channel-id';
  video.title = 'Title';
  video.status = VideoStatus.DRAFT;
  video.original_filename = 'file.mp4';
  video.mime_type = 'video/mp4';
  video.size_bytes = '1000';
  video.storage_key = 'videos/channel-id/video-id/original.mp4';
  video.thumbnail_key = null;
  video.upload_id = 'upload-id';
  video.duration_seconds = null;
  video.metadata = null;
  video.error_message = null;
  video.created_at = new Date();
  video.updated_at = new Date();
  Object.assign(video, overrides);
  return video;
}

function makeManager(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn((_entity, value) => Promise.resolve(value)),
    create: jest.fn((_entity, value) => value),
    ...overrides,
  };
}

function makeService(
  opts: {
    manager?: any;
    channelsService?: any;
    storageService?: any;
    config?: any;
    queue?: any;
  } = {},
) {
  const manager = opts.manager ?? makeManager();
  const dataSource = { manager } as any;
  const channelsService = opts.channelsService ?? {
    findByUserId: jest.fn().mockResolvedValue(makeChannel()),
  };
  const storageService = opts.storageService ?? {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadPartUrl: jest.fn().mockResolvedValue('https://signed-url'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    presignGetUrl: jest.fn().mockResolvedValue('https://signed-get-url'),
  };
  const config = opts.config ?? {
    uploadPartSizeBytes: 100,
    uploadUrlTtlSeconds: 3600,
    playbackUrlTtlSeconds: 300,
  };
  const queue = opts.queue ?? { add: jest.fn().mockResolvedValue(undefined) };

  const service = new VideosService(
    dataSource,
    channelsService,
    storageService,
    config,
    queue,
  );

  return { service, manager, channelsService, storageService, config, queue };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('computes exactly one part when sizeBytes fits in a single part', async () => {
      const { service, storageService } = makeService({
        config: {
          uploadPartSizeBytes: 100,
          uploadUrlTtlSeconds: 3600,
          playbackUrlTtlSeconds: 300,
        },
      });

      const result = await service.initiateUpload('user-id', {
        title: 'Title',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 100,
      });

      expect(result.parts).toHaveLength(1);
      expect(storageService.presignUploadPartUrl).toHaveBeenCalledTimes(1);
    });

    it('computes N parts for an exact multiple of the part size', async () => {
      const { service } = makeService({
        config: {
          uploadPartSizeBytes: 100,
          uploadUrlTtlSeconds: 3600,
          playbackUrlTtlSeconds: 300,
        },
      });

      const result = await service.initiateUpload('user-id', {
        title: 'Title',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 300,
      });

      expect(result.parts).toHaveLength(3);
      expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    });

    it('computes a remainder last part for a non-exact multiple', async () => {
      const { service } = makeService({
        config: {
          uploadPartSizeBytes: 100,
          uploadUrlTtlSeconds: 3600,
          playbackUrlTtlSeconds: 300,
        },
      });

      const result = await service.initiateUpload('user-id', {
        title: 'Title',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 250,
      });

      expect(result.parts).toHaveLength(3);
    });

    it('propagates the channel-less-user error without creating an upload', async () => {
      const channelsService = {
        findByUserId: jest.fn().mockRejectedValue(new Error('no channel')),
      };
      const { service, storageService } = makeService({ channelsService });

      await expect(
        service.initiateUpload('user-id', {
          title: 'Title',
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 100,
        }),
      ).rejects.toThrow('no channel');
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    it('rejects a video owned by a different channel without touching storage or the queue', async () => {
      const video = makeVideo({ channel_id: 'other-channel-id' });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service, storageService, queue } = makeService({ manager });

      await expect(
        service.completeUpload('user-id', 'video-id', { parts: [] }),
      ).rejects.toThrow(VideoNotFoundException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('rejects a video that is not in draft status without touching storage or the queue', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service, storageService, queue } = makeService({ manager });

      await expect(
        service.completeUpload('user-id', 'video-id', { parts: [] }),
      ).rejects.toThrow(VideoNotInDraftStatusException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('wraps a storage completion failure in VideoUploadCompletionFailedException', async () => {
      const video = makeVideo();
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storageService = {
        completeMultipartUpload: jest
          .fn()
          .mockRejectedValue(new Error('ETag mismatch')),
      };
      const { service, queue } = makeService({ manager, storageService });

      await expect(
        service.completeUpload('user-id', 'video-id', {
          parts: [{ partNumber: 1, eTag: 'abc' }],
        }),
      ).rejects.toThrow(VideoUploadCompletionFailedException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('transitions a valid draft video to processing and enqueues exactly one job', async () => {
      const video = makeVideo();
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service, queue } = makeService({ manager });

      const result = await service.completeUpload('user-id', 'video-id', {
        parts: [{ partNumber: 1, eTag: 'abc' }],
      });

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-id' },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    });
  });

  describe('findPublicVideo', () => {
    it('rejects a video that is not ready', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = makeService({ manager });

      await expect(service.findPublicVideo('video-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns a public DTO for a ready video', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = makeService({ manager });

      const result = await service.findPublicVideo('video-id');

      expect(result.id).toBe('video-id');
      expect((result as any).status).toBeUndefined();
    });
  });

  describe('getThumbnailRedirectUrl', () => {
    it('rejects a ready video with no thumbnail_key', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: null,
      });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = makeService({ manager });

      await expect(service.getThumbnailRedirectUrl('video-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('presigns the thumbnail key for a ready video that has one', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'videos/channel-id/video-id/thumbnail.jpg',
      });
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service, storageService } = makeService({ manager });

      const url = await service.getThumbnailRedirectUrl('video-id');

      expect(url).toBe('https://signed-get-url');
      expect(storageService.presignGetUrl).toHaveBeenCalledWith(
        'videos/channel-id/video-id/thumbnail.jpg',
        expect.objectContaining({ responseContentType: 'image/jpeg' }),
      );
    });
  });
});
