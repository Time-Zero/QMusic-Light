import type { Account, Playlist, Song } from '@qmusic/shared-types';
import type { QqApi } from '../qq/client';
import { asArr, asObj, mapDiss, toPlaylist } from '../qq/mappers';
import { TTL, type CacheStore } from '../cache/policy';

export interface PlaylistDetail {
  playlist: Playlist;
  songs: Song[];
  total: number;
  begin: number;
}

export class PlaylistService {
  constructor(
    private readonly api: QqApi,
    private readonly cache: CacheStore,
  ) {}

  /** 歌单详情：单次 song_num 最多 500，超过要翻页（文档 §3.7-6） */
  async detail(
    id: number,
    opts: { kind?: Playlist['kind']; begin?: number; num?: number; account?: Account } = {},
  ): Promise<PlaylistDetail> {
    const begin = opts.begin ?? 0;
    const num = Math.min(opts.num ?? 500, 500);
    const kind = opts.kind ?? 'public';
    const key = `diss:${id}:${begin}:${num}:${opts.account?.uin ?? 'guest'}`;
    const cached = this.cache.get<PlaylistDetail>(key);
    if (cached) return cached;

    const isLiked = id === 0 && kind === 'liked';
    const data = await this.api.diss(isLiked ? 0 : id, {
      dirid: isLiked ? 201 : 0,
      begin,
      num,
      encHostUin: opts.account?.encryptUin,
    });
    const mapped = mapDiss(data, kind);
    if (isLiked && !mapped.playlist.title) mapped.playlist.title = '我喜欢的音乐';
    if (isLiked) {
      mapped.playlist.id = 0;
      mapped.playlist.dirid = 201;
    }

    const result: PlaylistDetail = { ...mapped, begin };
    this.cache.set(key, result, TTL.playlistDetail);
    return result;
  }

  async tracks(id: number, begin = 0, limit = 500, account?: Account): Promise<PlaylistDetail> {
    return this.detail(id, { begin, num: limit, account });
  }

  /** 我的歌单（自建） */
  async mine(account: Account): Promise<Playlist[]> {
    const key = `mine:${account.uin}`;
    const cached = this.cache.get<Playlist[]>(key);
    if (cached) return cached;

    const data = await this.api.myPlaylists(account.uin);
    const lists = asArr<Record<string, unknown>>(
      asObj(data).v_playlist ?? asObj(data).playlist ?? asObj(data).v_list ?? asObj(data).list,
    );
    const mapped = lists
      .map((item) => toPlaylist(asObj(item).dirinfo ?? item, 'created'))
      .filter((p): p is Playlist => !!p && p.dirid !== 201);
    this.cache.set(key, mapped, TTL.myPlaylists);
    return mapped;
  }

  /** 收藏的歌单 */
  async collected(account: Account, offset = 0, size = 30): Promise<Playlist[]> {
    const key = `fav:${account.uin}:${offset}:${size}`;
    const cached = this.cache.get<Playlist[]>(key);
    if (cached) return cached;

    const data = await this.api.favPlaylists(account.encryptUin, offset, size);
    const lists = asArr<Record<string, unknown>>(
      asObj(data).v_playlist ?? asObj(data).playlist ?? asObj(data).v_list ?? asObj(data).list,
    );
    const mapped = lists
      .map((item) => {
        const basic = asObj(item).basic ?? asObj(asObj(item).Playlist).basic;
        const content = asObj(asObj(item).content);
        const source = Object.keys(asObj(basic)).length > 0 ? asObj(basic) : item;
        const list = toPlaylist(source, 'collected');
        if (list && !list.songCount) {
          const items = asArr(content.v_item);
          if (items.length > 0) list.songCount = items.length;
        }
        return list;
      })
      .filter((p): p is Playlist => !!p);
    this.cache.set(key, mapped, TTL.myPlaylists);
    return mapped;
  }

  /** 我喜欢：dirid=201，disstid=0（文档 §3.4） */
  async liked(account: Account, begin = 0, num = 500): Promise<PlaylistDetail> {
    return this.detail(0, { kind: 'liked', begin, num, account });
  }

  async addLike(account: Account, song: Song): Promise<void> {
    await this.api.addLike(song);
    this.invalidateLikeCaches(account);
  }

  async removeLike(account: Account, song: Song): Promise<void> {
    await this.api.delLike(song);
    this.invalidateLikeCaches(account);
  }

  /** 红心变更后，所有分页的「我喜欢」详情都要重新拉取 */
  private invalidateLikeCaches(account: Account): void {
    this.cache.delete(`mine:${account.uin}`);
    this.cache.delete(`fav:${account.uin}:0:30`);
    this.cache.deletePrefix('diss:0:');
  }
}
