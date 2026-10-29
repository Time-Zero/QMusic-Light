import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 领域模型（IPC 与 UI 共用）。所有外部接口返回值必须映射到这里的类型，
 * 由 zod schema 在边界做运行时校验（文档 §5.3）。
 * ------------------------------------------------------------------ */

export const QualitySchema = z.enum(['flac', '320', '128', 'aac']);
export type Quality = z.infer<typeof QualitySchema>;

export const QUALITY_LABEL: Record<Quality, string> = {
  flac: '无损 FLAC',
  '320': 'HQ 320k',
  '128': '标准 128k',
  aac: 'AAC',
};

/** 降级顺序：FLAC → 320 → 128 → 试听（文档 §3.5） */
export const QUALITY_CHAIN: Quality[] = ['flac', '320', '128'];

export interface Singer {
  id: number;
  mid: string;
  name: string;
}

const SingerSchema = z.object({
  id: z.number().catch(0),
  mid: z.string().catch(''),
  name: z.string().catch(''),
});

export interface Song {
  mid: string;
  id: number;
  name: string;
  title: string;
  albumMid: string;
  albumName: string;
  singers: Singer[];
  cover: string;
  duration: number;
  /** vkey 的 filename 使用 file.media_mid，可能与 songmid 不同（文档 §3.5） */
  mediaMid: string;
  payPlay: number;
  /** 无版权 / 需会员 / 需购买：UI 只提示不可播，不做破解（文档 §9.3） */
  playable: boolean;
  /** 从 track_info.type 透传，vkey 请求需要（文档 §3.4 注） */
  songType: number;
  /** 最高可用音质提示（依据 file 体积推断） */
  maxQuality?: Quality;
}

export const SongSchema = z.object({
  mid: z.string().min(1),
  id: z.number().catch(0),
  name: z.string().catch(''),
  title: z.string().catch(''),
  albumMid: z.string().catch(''),
  albumName: z.string().catch(''),
  singers: z.array(SingerSchema).catch([]),
  cover: z.string().catch(''),
  duration: z.number().catch(0),
  mediaMid: z.string().catch(''),
  payPlay: z.number().catch(0),
  playable: z.boolean().catch(true),
  songType: z.number().catch(0),
  maxQuality: QualitySchema.optional(),
});

export type PlaylistKind = 'created' | 'collected' | 'liked' | 'daily' | 'public';

export interface Playlist {
  id: number;
  dirid: number;
  title: string;
  cover: string;
  description: string;
  songCount: number;
  playCount: number;
  creator: string;
  kind: PlaylistKind;
  tags?: string[];
}

export const PlaylistSchema = z.object({
  id: z.number(),
  dirid: z.number().catch(0),
  title: z.string().catch(''),
  cover: z.string().catch(''),
  description: z.string().catch(''),
  songCount: z.number().catch(0),
  playCount: z.number().catch(0),
  creator: z.string().catch(''),
  kind: z.enum(['created', 'collected', 'liked', 'daily', 'public']).catch('public'),
  tags: z.array(z.string()).optional(),
});

export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export type QrState = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'cancelled';

export interface Account {
  uin: string;
  nickname: string;
  avatar: string;
  encryptUin: string;
  vipLevel: number;
  keyExpiresAt: number;
  vipLabel?: string;
}

export const AccountSchema = z.object({
  uin: z.string(),
  nickname: z.string().catch(''),
  avatar: z.string().catch(''),
  encryptUin: z.string().catch(''),
  vipLevel: z.number().catch(0),
  keyExpiresAt: z.number().catch(0),
  vipLabel: z.string().optional(),
});

export interface FeedCard {
  type: 'song' | 'playlist' | 'function' | 'entry';
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  song?: Song;
  playlistId?: number;
  rank?: number;
}

export interface FeedSection {
  id: string;
  title: string;
  subtitle: string;
  cards: FeedCard[];
}

export interface LyricLine {
  time: number;
  text: string;
  trans?: string;
}

export interface Lyric {
  lrc: string;
  trans: string;
  lines: LyricLine[];
  /** 纯音乐 / 无歌词 */
  instrumental: boolean;
}

export interface StreamInfo {
  url: string;
  quality: Quality;
  expiresAt: number;
  /** 试听片段 */
  trial: boolean;
}

export interface RecentPlay {
  song: Song;
  playedAt: number;
}

export interface SearchSuggestions {
  songs: { mid: string; name: string; singer: string }[];
  singers: { mid: string; name: string; pic: string }[];
  albums: { mid: string; name: string; singer: string; pic: string }[];
  playlists: { id: number; name: string; cover: string }[];
}

export interface SearchResult {
  songs: Page<Song>;
  playlists: Page<Playlist>;
  singers: Page<{ mid: string; name: string; pic: string }>;
}

export type PlayMode = 'order' | 'shuffle' | 'single';

/* ------------------------------------------------------------------ *
 * IPC DTO（文档 §5.3：业务命令面保持很窄）
 * ------------------------------------------------------------------ */

export interface ApiCallRequest {
  module: string;
  method: string;
  param: Record<string, unknown>;
  comm?: Record<string, unknown>;
}

export interface LegacyRequest {
  /** 老 CGI 路径，如 /splcloud/fcgi-bin/smartbox_new.fcg */
  path: string;
  /** 允许 c.y.qq.com / c6.y.qq.com，平台层会做域名白名单 */
  host?: string;
  query?: Record<string, string | number>;
}

export interface SysInfo {
  version: string;
  webview: string;
  platform: string;
  runtime: 'tauri' | 'browser';
}

export interface QrStartResult {
  qrId: string;
  imageDataUrl: string;
  expiresAt: number;
}

export interface QrPollResult {
  state: QrState;
  message?: string;
  account?: Account;
}

export interface RestoreResult {
  account?: Account;
  /** 登录态过期，需要重新扫码 */
  expired?: boolean;
}

export type DbValue = string | number | null;

export interface DbResult {
  rows?: Record<string, DbValue>[];
  changes?: number;
}
