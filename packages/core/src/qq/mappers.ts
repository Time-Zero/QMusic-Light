import type {
  FeedCard,
  FeedSection,
  LyricLine,
  Playlist,
  PlaylistKind,
  Quality,
  Song,
} from '@qmusic/shared-types';
import { SongSchema, PlaylistSchema } from '@qmusic/shared-types';
import { albumCoverUrl, playlistCoverUrl } from './endpoints';

/* --------------------------- 取值helpers --------------------------- */

export type Raw = Record<string, unknown>;

export function asObj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

export function asArr<T = Raw>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function str(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

export function num(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) return Number(c);
  }
  return 0;
}

export function bool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return fallback;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ------------------------------ Song ------------------------------ */

/**
 * vkey 的 songtype 只认 0（普通）/1（伴唱）。歌单接口里的 `songtype` 是来源标记
 * （实测恒为 12/13），透传会让服务端返回 101404、purl 为空，表现为「无版权或需要会员」。
 * 因此只取 track_info.type，并把其它取值收敛回 0。
 */
export function normalizeSongType(raw: Raw): number {
  return sanitizeSongType(num(raw.type, raw.songtype));
}

/** 同一条规则用在已持久化的 Song 上：老队列里可能还留着 12/13 */
export function sanitizeSongType(value: number): number {
  return value === 1 ? 1 : 0;
}

function detectMaxQuality(file: Raw): Quality | undefined {
  if (num(file.size_flac, file.size_hires) > 0) return 'flac';
  if (num(file.size_320mp3) > 0) return '320';
  if (num(file.size_128mp3) > 0) return '128';
  if (num(file.size_96aac, file.size_48aac, file.size_24aac) > 0) return 'aac';
  return undefined;
}

export function toSong(rawInput: unknown): Song | null {
  const raw = asObj(rawInput);
  const mid = str(raw.mid, raw.songmid, raw.songMid);
  if (!mid) return null;

  const album = asObj(raw.album);
  const file = asObj(raw.file);
  const pay = asObj(raw.pay);
  const singers = asArr<Raw>(raw.singer)
    .map((s) => ({
      id: num(s.id),
      mid: str(s.mid),
      name: decodeEntities(str(s.name, s.title)),
    }))
    .filter((s) => s.name.length > 0);

  const albumMid = str(album.mid, album.albumMid, raw.albummid);
  const cover = playlistCoverUrl(str(album.picUrl, raw.cover)) || albumCoverUrl(albumMid, 300);
  const maxQuality = detectMaxQuality(file);
  const hasFile = maxQuality !== undefined;
  const only = num(raw.isonly);
  const name = decodeEntities(str(raw.name, raw.title, raw.songname));

  const mapped: Song = {
    mid,
    id: num(raw.id, raw.songid, raw.songId),
    name,
    title: decodeEntities(str(raw.title, raw.name, name)),
    albumMid,
    albumName: decodeEntities(str(album.name, album.title, raw.albumname)),
    singers,
    cover,
    duration: num(raw.interval, raw.duration),
    mediaMid: str(file.media_mid, raw.media_mid, raw.mediaMid, mid),
    payPlay: num(pay.pay_play, raw.payplay),
    playable: hasFile && only === 0,
    songType: normalizeSongType(raw),
    maxQuality,
  };

  const parsed = SongSchema.safeParse(mapped);
  return parsed.success ? parsed.data : mapped;
}

export function toSongs(list: unknown): Song[] {
  return asArr(list)
    .map(toSong)
    .filter((s): s is Song => s !== null);
}

/* ---------------------------- Playlist ---------------------------- */

export function toPlaylist(rawInput: unknown, kind: PlaylistKind = 'public'): Playlist | null {
  const outer = asObj(rawInput);
  const wrapped = asObj(outer.Playlist);
  const raw = Object.keys(wrapped).length > 0 ? wrapped : outer;
  const basic = asObj(raw.basic);
  const source = Object.keys(basic).length > 0 ? basic : raw;
  const cover = asObj(source.cover);
  const creator = asObj(source.creator);

  const id = num(source.tid, source.dissid, source.disstid, source.id, source.dirId);
  if (!id) return null;

  const mapped: Playlist = {
    id,
    dirid: num(source.dirid, source.dirId, raw.dirid),
    title: decodeEntities(str(source.title, source.name, source.dirName)),
    cover: playlistCoverUrl(
      str(cover.default_url, cover.small_url, cover.big_url, source.picurl, source.cover, source.picUrl),
    ),
    description: decodeEntities(str(source.desc, source.description)),
    songCount: num(source.song_cnt, source.songnum, source.songNum, source.total_song_num),
    playCount: num(source.play_cnt, source.listennum, source.listenNum),
    creator: decodeEntities(str(creator.nick, source.host_nick, source.nickname, source.creator)),
    kind,
    tags: asArr<Raw>(source.v_tag)
      .map((t) => str(t.name))
      .filter(Boolean),
  };

  const parsed = PlaylistSchema.safeParse(mapped);
  return parsed.success ? parsed.data : mapped;
}

export function toPlaylists(list: unknown, kind: PlaylistKind = 'public'): Playlist[] {
  return asArr(list)
    .map((item) => toPlaylist(asObj(item).Playlist ?? item, kind))
    .filter((p): p is Playlist => p !== null);
}

/* -------------------------- Playlist detail -------------------------- */

export interface DissResult {
  playlist: Playlist;
  songs: Song[];
  total: number;
}

export function mapDiss(dataInput: unknown, kind: PlaylistKind = 'public'): DissResult {
  const data = asObj(dataInput);
  const dirinfo = asObj(data.dirinfo);
  const songs = toSongs(data.songlist);
  const tags = asArr<Raw>(dirinfo.tag)
    .map((t) => str(t.name))
    .filter(Boolean);

  const playlist: Playlist = {
    id: num(dirinfo.id, dirinfo.disstid, data.disstid),
    dirid: num(dirinfo.dirid, data.dirid),
    title: decodeEntities(str(dirinfo.title, data.title)),
    cover: playlistCoverUrl(str(dirinfo.picurl, dirinfo.cover)),
    description: decodeEntities(str(dirinfo.desc, dirinfo.description)),
    songCount: num(dirinfo.songnum, data.total_song_num, songs.length),
    playCount: num(dirinfo.listennum),
    creator: decodeEntities(str(dirinfo.host_nick, asObj(dirinfo.creator).nick)),
    kind,
    tags,
  };

  return {
    playlist,
    songs,
    total: num(data.total_song_num, playlist.songCount, songs.length),
  };
}

/* --------------------------- Song detail --------------------------- */

export function mapSongDetail(dataInput: unknown): Song | null {
  const data = asObj(dataInput);
  return toSong(data.track_info ?? data);
}

/* ---------------------------- Feed ---------------------------- */

const SHELF_FALLBACK_TITLES = ['为你推荐', '编辑精选', '私人订制', '新歌速递', '猜你喜欢', '精选歌单'];

function toFeedCard(rawInput: unknown): FeedCard | null {
  const raw = asObj(rawInput);
  const type = num(raw.type);
  const id = str(raw.id, raw.tid, raw.mid);
  const misc = asObj(raw.miscellany);
  const title = decodeEntities(str(raw.title, raw.name));
  const subtitle = decodeEntities(
    str(misc.cnt_content, raw.subtitle, misc.rcmdtemplate, raw.rcmdcontent, asObj(raw.singer).name),
  );
  const cover = playlistCoverUrl(str(raw.cover, asObj(raw.cover).default_url, raw.picurl));

  if (type === 200) {
    const song = toSong(raw.song ?? raw.track ?? raw);
    if (!song) return null;
    return { type: 'song', id: song.mid, title: song.name, subtitle, cover: song.cover || cover, song };
  }
  if (type === 500) {
    const playlistId = num(raw.id, raw.tid, asObj(raw.basic).tid);
    if (!playlistId) return null;
    return {
      type: 'playlist',
      id: String(playlistId),
      title,
      subtitle,
      cover: cover || playlistCoverUrl(str(asObj(raw.basic).cover)),
      playlistId,
    };
  }
  if (type === 700 || type === 900) {
    if (!title) return null;
    return { type: type === 700 ? 'function' : 'entry', id: id || title, title, subtitle, cover };
  }
  return null;
}

export function mapFeed(dataInput: unknown): FeedSection[] {
  const data = asObj(dataInput);
  const shelves = asArr<Raw>(data.v_shelf);
  const sections: FeedSection[] = [];

  shelves.forEach((shelf, index) => {
    const niches = asArr<Raw>(shelf.v_niche);
    const cards = niches.flatMap((niche) => asArr(niche.v_card)).map(toFeedCard).filter((c): c is FeedCard => !!c);
    if (cards.length === 0) return;

    const title = decodeEntities(
      str(shelf.title_content, shelf.title, asObj(shelf.extra_info).title, cardTitle(cards)),
    );
    sections.push({
      id: `shelf-${str(shelf.id) || index}`,
      title: title || SHELF_FALLBACK_TITLES[index % SHELF_FALLBACK_TITLES.length],
      subtitle: decodeEntities(str(shelf.subtitle, asObj(shelf.extra_info).subtitle, '')),
      cards,
    });
  });

  return sections;
}

function cardTitle(cards: FeedCard[]): string {
  const playlist = cards.find((c) => c.type === 'playlist');
  return playlist ? '精选歌单' : '今日推荐';
}

/** 从推荐流里找到"每日30首"卡片（文档 §3.4 / §3.7-5） */
export function findDailyPlaylistId(feed: unknown): number {
  const shelves = asArr<Raw>(asObj(feed).v_shelf);
  for (const shelf of shelves) {
    for (const niche of asArr<Raw>(shelf.v_niche)) {
      for (const raw of asArr<Raw>(niche.v_card)) {
        const card = asObj(raw);
        const title = str(card.title, asObj(card.miscellany).rcmdtemplate);
        const looksDaily = title.includes('每日30首') || title.includes('每日 30 首');
        if (!looksDaily) continue;
        const direct = num(card.id, asObj(card.basic).tid);
        if (direct) return direct;
        const scheme = str(card.scheme, card.jumpurl, asObj(card.miscellany).layer_url);
        const matched = scheme.match(/disstid=(\d+)/);
        if (matched) return Number(matched[1]);
      }
    }
  }
  return 0;
}

/* --------------------------- Playlist square --------------------------- */

export function mapSquare(dataInput: unknown): Playlist[] {
  const data = asObj(dataInput);
  const list = asArr(data.List);
  if (list.length > 0) return toPlaylists(list, 'public');
  return toPlaylists(data.v_playlist ?? data.list, 'public');
}

/* ---------------------------- Search ---------------------------- */

export interface RawSearchPage {
  items: unknown[];
  total: number;
}

export function pickSearchBody(dataInput: unknown): Raw {
  return asObj(asObj(dataInput).body);
}

/* ------------------------------ Lyric ------------------------------ */

function decodeBase64Utf8(input: string): string {
  const binary = atob(input.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return binary;
  }
}

export function decodeLyricField(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    return decodeBase64Utf8(value);
  } catch {
    return value;
  }
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

export function parseLrc(lrc: string, trans = ''): LyricLine[] {
  const collect = (text: string): Map<number, string> => {
    const map = new Map<number, string>();
    if (!text) return map;
    let offset = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const offsetMatch = rawLine.match(/^\[offset:(-?\d+)\]$/i);
      if (offsetMatch) {
        offset = Number(offsetMatch[1]) / 1000;
        continue;
      }
      TIME_TAG.lastIndex = 0;
      const times: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = TIME_TAG.exec(rawLine))) {
        const min = Number(match[1]);
        const sec = Number(match[2].replace(':', '.'));
        times.push(min * 60 + sec);
      }
      if (times.length === 0) continue;
      const content = rawLine.replace(TIME_TAG, '').trim();
      for (const t of times) {
        map.set(Math.round((t + offset) * 1000) / 1000, content);
      }
    }
    return map;
  };

  const main = collect(lrc);
  const translation = collect(trans);
  const times = [...main.keys()].sort((a, b) => a - b);

  return times.map((time) => ({
    time,
    text: main.get(time) ?? '',
    trans: translation.get(time) || undefined,
  }));
}

export function activeLineIndex(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= currentTime) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}
