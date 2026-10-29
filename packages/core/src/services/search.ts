import type { Page, Playlist, SearchResult, SearchSuggestions, Song } from '@qmusic/shared-types';
import { QqApiError, type ApiTransport, type QqApi } from '../qq/client';
import { asArr, asObj, num, pickSearchBody, str, toPlaylists, toSongs } from '../qq/mappers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SingerHit {
  mid: string;
  name: string;
  pic: string;
}

function pageOf<T>(items: T[], total: number, page: number, perPage: number): Page<T> {
  return { items, total, hasMore: page * perPage < total };
}

export class SearchService {
  constructor(
    private readonly api: QqApi,
    private readonly transport: ApiTransport,
  ) {}

  async songs(query: string, page = 1, perPage = 30): Promise<Page<Song>> {
    const body = await this.fetchBody(query, page, perPage);
    const items = toSongs(asArr(asObj(body.song).list));
    const total = num(asObj(body.meta).sum, items.length);
    return pageOf(items, total, page, perPage);
  }

  async playlists(query: string, page = 1, perPage = 30): Promise<Page<Playlist>> {
    const body = await this.fetchBody(query, page, perPage);
    const items = toPlaylists(asArr(asObj(body.songlist).list), 'public');
    const total = num(asObj(body.meta).sum, items.length);
    return pageOf(items, total, page, perPage);
  }

  async singers(query: string, page = 1, perPage = 30): Promise<Page<SingerHit>> {
    const body = await this.fetchBody(query, page, perPage);
    const items = asArr<Record<string, unknown>>(asObj(body.singer).list).map((s) => ({
      mid: str(s.mid),
      name: str(s.name, s.title),
      pic: str(s.pic, s.picUrl),
    }));
    const total = num(asObj(body.meta).sum, items.length);
    return pageOf(items, total, page, perPage);
  }

  async all(query: string, page = 1, perPage = 30): Promise<SearchResult> {
    const body = await this.fetchBody(query, page, perPage);
    const meta = asObj(body.meta);
    const songs = pageOf(toSongs(asArr(asObj(body.song).list)), num(meta.sum, 0), page, perPage);
    const playlists = pageOf(
      toPlaylists(asArr(asObj(body.songlist).list), 'public'),
      num(meta.sum, 0),
      page,
      perPage,
    );
    const singers = pageOf(
      asArr<Record<string, unknown>>(asObj(body.singer).list).map((s) => ({
        mid: str(s.mid),
        name: str(s.name, s.title),
        pic: str(s.pic),
      })),
      num(meta.sum, 0),
      page,
      perPage,
    );
    return { songs, playlists, singers };
  }

  /** 联想词走老接口，匿名可用（文档 §3.4） */
  async suggest(key: string): Promise<SearchSuggestions> {
    const empty: SearchSuggestions = { songs: [], singers: [], albums: [], playlists: [] };
    if (!key.trim()) return empty;

    const raw = asObj(
      await this.transport.legacy({
        path: '/splcloud/fcgi-bin/smartbox_new.fcg',
        query: {
          key,
          format: 'json',
          inCharset: 'utf8',
          outCharset: 'utf-8',
          platform: 'yqq.json',
          needNewCode: 0,
        },
      }),
    );
    const data = asObj(raw.data);
    const pick = (section: unknown) =>
      asArr<Record<string, unknown>>(asObj(section).itemlist).map((item) => ({
        mid: str(item.mid),
        name: str(item.name),
        singer: str(item.singer),
        pic: str(item.pic),
        id: num(item.id),
      }));

    return {
      songs: pick(data.song).map((s) => ({ mid: s.mid, name: s.name, singer: s.singer })),
      singers: pick(data.singer).map((s) => ({ mid: s.mid, name: s.name, pic: s.pic })),
      albums: pick(data.album).map((a) => ({ mid: a.mid, name: a.name, singer: a.singer, pic: a.pic })),
      playlists: pick(data.songlist).map((p) => ({ id: p.id, name: p.name, cover: p.pic })),
    };
  }

  private body(data: unknown): Record<string, unknown> {
    return pickSearchBody(data);
  }

  /**
   * 搜索接口偶发 2001（风控 / 未登录）。退避重试一次，仍失败则返回空结果，
   * 由 UI 给出「稍后重试或登录」的提示，而不是把错误抛成白屏（文档 §5.3）。
   */
  private async fetchBody(query: string, page: number, perPage: number): Promise<Record<string, unknown>> {
    try {
      return this.body(await this.api.search(query, page, perPage));
    } catch (error) {
      if (error instanceof QqApiError && (error.code === 2001 || error.code === 80030)) {
        await sleep(400);
        try {
          return this.body(await this.api.search(query, page, perPage));
        } catch (retryError) {
          if (retryError instanceof QqApiError && retryError.code === 2001) return {};
          throw retryError;
        }
      }
      throw error;
    }
  }
}
