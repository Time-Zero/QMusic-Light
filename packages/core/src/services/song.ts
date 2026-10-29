import type { Lyric, Song } from '@qmusic/shared-types';
import type { QqApi } from '../qq/client';
import { asObj, decodeLyricField, mapSongDetail, parseLrc, toSongs } from '../qq/mappers';
import { TTL, type CacheStore } from '../cache/policy';

export class SongService {
  constructor(
    private readonly api: QqApi,
    private readonly cache: CacheStore,
  ) {}

  async detail(mid: string): Promise<Song | null> {
    const key = `song:${mid}`;
    const cached = this.cache.get<Song>(key);
    if (cached) return cached;

    const data = await this.api.songDetail(mid);
    const song = mapSongDetail(data);
    if (song) this.cache.set(key, song, TTL.songDetail);
    return song;
  }

  async tracks(mids: string[]): Promise<Song[]> {
    if (mids.length === 0) return [];
    const missing: string[] = [];
    const hits = new Map<string, Song>();
    for (const mid of mids) {
      const cached = this.cache.get<Song>(`song:${mid}`);
      if (cached) hits.set(mid, cached);
      else missing.push(mid);
    }
    if (missing.length > 0) {
      try {
        const data = await this.api.tracks(missing);
        const list = toSongs(asObj(data).tracks ?? data);
        for (const song of list) {
          hits.set(song.mid, song);
          this.cache.set(`song:${song.mid}`, song, TTL.songDetail);
        }
      } catch {
        // 批量补数据失败不阻塞列表，慢路径逐首回源
      }
    }
    return mids.map((mid) => hits.get(mid)).filter((s): s is Song => !!s);
  }

  async lyric(song: Pick<Song, 'mid' | 'id'>): Promise<Lyric> {
    const key = `lyric:${song.mid}`;
    const cached = this.cache.get<Lyric>(key);
    if (cached) return cached;

    const data = asObj(await this.api.lyric(song.mid, song.id));
    const lrc = decodeLyricField(data.lyric);
    const trans = decodeLyricField(data.trans);
    const lines = parseLrc(lrc, trans);
    const result: Lyric = {
      lrc,
      trans,
      lines,
      // 有文本但无时间轴属于「未同步歌词」，不是纯音乐
      instrumental: lines.length === 0 && lrc.trim().length === 0,
    };
    this.cache.set(key, result, TTL.lyric);
    return result;
  }
}
