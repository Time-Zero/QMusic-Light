import type { Core } from '@core';
import type { CachedStream, Quality, Song, StreamInfo } from '@qmusic/shared-types';
import { useSettingsStore } from '@/app/settings-store';
import { bridge, IS_TAURI } from '@/bridge';

/** 与 Rust 侧 FILE_META / buildFilename 的文件后缀保持一致 */
const EXT: Record<Quality, string> = {
  flac: 'flac',
  '320': 'mp3',
  '128': 'mp3',
  aac: 'm4a',
};

/**
 * 未命中缓存时，最多等这么久把整首抓下来再开播。
 * 下载够快就等于「本地播放」，慢网超过这个时间立刻回落直链，绝不让点了没反应。
 */
const PREFETCH_WAIT_MS = 2500;

export function cacheKey(song: Pick<Song, 'mid'>, quality: Quality): string {
  return `${quality}-${song.mid}`;
}

export function cacheExt(quality: Quality): string {
  return EXT[quality] ?? 'mp3';
}

export function cacheEnabled(): boolean {
  return IS_TAURI && useSettingsStore.getState().streamCache;
}

async function readLocal(key: string, ext: string): Promise<CachedStream | null> {
  try {
    return await bridge.cache.get(key, ext);
  } catch {
    return null;
  }
}

/** 纯本地地址（命中缓存时才有），供播放失败时兜底 */
export async function localSrc(song: Pick<Song, 'mid'>, quality: Quality): Promise<string | null> {
  if (!cacheEnabled()) return null;
  const hit = await readLocal(cacheKey(song, quality), cacheExt(quality));
  return hit?.url ?? null;
}

/**
 * 决定这一首要播放的 src：
 * 1. 已落盘 → 直接读本地，后续与网络无关；
 * 2. 否则先抢一小段时间预取整首（成功即本地播放）；
 * 3. 预取没赶上 → 取消任务、回落直链，保证点击即响。
 */
export async function preparePlaybackSrc(song: Song, info: StreamInfo): Promise<string> {
  if (!cacheEnabled()) return info.url;
  const key = cacheKey(song, info.quality);
  const ext = cacheExt(info.quality);

  const hit = await readLocal(key, ext);
  if (hit) return hit.url;

  const timedOut = Symbol('prefetch-timeout');
  const result = await Promise.race([
    bridge.cache.prefetch({ key, url: info.url, ext }).catch(() => null),
    delay(PREFETCH_WAIT_MS).then(() => timedOut),
  ]);

  if (result === timedOut) {
    void bridge.cache.cancel(key, ext).catch(() => undefined);
    return info.url;
  }
  return (result as CachedStream | null)?.url ?? info.url;
}

/** 提前把下一首下载好：切歌瞬间起播，网络抖动也听不出来 */
export async function prefetchTrack(instance: Core, song: Song): Promise<void> {
  if (!cacheEnabled()) return;
  const info = await instance.stream.resolve(song);
  const key = cacheKey(song, info.quality);
  const ext = cacheExt(info.quality);
  if (await readLocal(key, ext)) return;
  await bridge.cache.prefetch({ key, url: info.url, ext });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
