export function buildOriginalKey(
  channelId: string,
  videoId: string,
  extension: string,
): string {
  return `videos/${channelId}/${videoId}/original.${extension}`;
}

export function buildThumbnailKey(channelId: string, videoId: string): string {
  return `videos/${channelId}/${videoId}/thumbnail.jpg`;
}
