import type { Playlist, Song } from '@qmusic/shared-types';
import { asArr } from '../qq/mappers';
import { toNum, toStr, type DbClient } from './db';

const MAX_HISTORY = 300;

/**
 * 本地库：歌曲、播放历史、每日推荐快照、歌单快照、设置。
 * 表结构与文档 §6.2 一致；凭证不进这里（文档 §6.2 注）。
 */
export class LibraryRepo {
  constructor(private readonly db: DbClient) {}

  private async upsertSongs(songs: Song[]) {
    for (const song of songs) {
      await this.db.execute(
        `INSERT INTO song (mid, song_id, name, album_mid, album_name, singers_json, cover, duration, pay_play, media_mid, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mid) DO UPDATE SET
           song_id=excluded.song_id, name=excluded.name, album_mid=excluded.album_mid,
           album_name=excluded.album_name, singers_json=excluded.singers_json, cover=excluded.cover,
           duration=excluded.duration, pay_play=excluded.pay_play, media_mid=excluded.media_mid,
           updated_at=excluded.updated_at`,
        [
          song.mid,
          song.id,
          song.name,
          song.albumMid,
          song.albumName,
          JSON.stringify(song.singers),
          song.cover,
          song.duration,
          song.payPlay,
          song.mediaMid,
          Date.now(),
        ],
      );
    }
  }

  private songFromRow(row: Record<string, string | number | null>): Song {
    return {
      mid: toStr(row.mid),
      id: toNum(row.song_id),
      name: toStr(row.name),
      title: toStr(row.name),
      albumMid: toStr(row.album_mid),
      albumName: toStr(row.album_name),
      singers: safeSingers(toStr(row.singers_json)),
      cover: toStr(row.cover),
      duration: toNum(row.duration),
      mediaMid: toStr(row.media_mid),
      payPlay: toNum(row.pay_play),
      playable: true,
      songType: 0,
    };
  }

  async addHistory(song: Song, playedAt = Date.now()): Promise<void> {
    await this.upsertSongs([song]);
    await this.db.execute(
      `INSERT INTO play_history (song_mid, played_at) VALUES (?, ?)
       ON CONFLICT(song_mid, played_at) DO NOTHING`,
      [song.mid, playedAt],
    );
    await this.db.execute(
      `DELETE FROM play_history WHERE played_at < (
         SELECT played_at FROM play_history ORDER BY played_at DESC LIMIT 1 OFFSET ?
       )`,
      [MAX_HISTORY],
    );
  }

  async recent(limit = 30): Promise<{ song: Song; playedAt: number }[]> {
    const rows = await this.db.select(
      `SELECT s.*, h.played_at AS played_at FROM play_history h
       JOIN song s ON s.mid = h.song_mid
       ORDER BY h.played_at DESC LIMIT ?`,
      [limit],
    );
    const seen = new Set<string>();
    const result: { song: Song; playedAt: number }[] = [];
    for (const row of rows) {
      const song = this.songFromRow(row);
      if (seen.has(song.mid)) continue;
      seen.add(song.mid);
      result.push({ song, playedAt: toNum(row.played_at) });
    }
    return result;
  }

  async clearHistory(): Promise<void> {
    await this.db.execute('DELETE FROM play_history');
  }

  async saveDaily(day: string, songs: Song[]): Promise<void> {
    await this.upsertSongs(songs);
    await this.db.execute('DELETE FROM daily_recommend WHERE day = ?', [day]);
    for (let i = 0; i < songs.length; i++) {
      await this.db.execute(
        'INSERT INTO daily_recommend (day, song_mid, position) VALUES (?, ?, ?) ON CONFLICT(day, song_mid) DO UPDATE SET position=excluded.position',
        [day, songs[i].mid, i],
      );
    }
  }

  async loadDaily(day: string): Promise<Song[]> {
    const rows = await this.db.select(
      `SELECT s.* FROM daily_recommend d JOIN song s ON s.mid = d.song_mid
       WHERE d.day = ? ORDER BY d.position ASC`,
      [day],
    );
    return rows.map((row) => this.songFromRow(row));
  }

  async savePlaylist(playlist: Playlist, songs: Song[], ownerUin = ''): Promise<void> {
    await this.db.execute(
      `INSERT INTO playlist (id, owner_uin, dirid, title, cover, description, song_count, play_count, kind, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, owner_uin) DO UPDATE SET
         dirid=excluded.dirid, title=excluded.title, cover=excluded.cover, description=excluded.description,
         song_count=excluded.song_count, play_count=excluded.play_count, kind=excluded.kind, synced_at=excluded.synced_at`,
      [
        playlist.id,
        ownerUin,
        playlist.dirid,
        playlist.title,
        playlist.cover,
        playlist.description,
        playlist.songCount,
        playlist.playCount,
        playlist.kind,
        Date.now(),
      ],
    );
    await this.upsertSongs(songs);
    await this.db.execute('DELETE FROM playlist_track WHERE playlist_id = ? AND owner_uin = ?', [
      playlist.id,
      ownerUin,
    ]);
    for (let i = 0; i < songs.length; i++) {
      await this.db.execute(
        'INSERT INTO playlist_track (playlist_id, owner_uin, song_mid, position) VALUES (?, ?, ?, ?)',
        [playlist.id, ownerUin, songs[i].mid, i],
      );
    }
  }

  async loadPlaylist(id: number, ownerUin = ''): Promise<{ playlist: Playlist; songs: Song[] } | null> {
    const rows = await this.db.select('SELECT * FROM playlist WHERE id = ? AND owner_uin = ?', [id, ownerUin]);
    if (rows.length === 0) return null;
    const row = rows[0];
    const trackRows = await this.db.select(
      `SELECT s.* FROM playlist_track t JOIN song s ON s.mid = t.song_mid
       WHERE t.playlist_id = ? AND t.owner_uin = ? ORDER BY t.position ASC`,
      [id, ownerUin],
    );
    return {
      playlist: {
        id: toNum(row.id),
        dirid: toNum(row.dirid),
        title: toStr(row.title),
        cover: toStr(row.cover),
        description: toStr(row.description),
        songCount: toNum(row.song_count),
        playCount: toNum(row.play_count),
        creator: '',
        kind: (toStr(row.kind, 'public') as Playlist['kind']) ?? 'public',
      },
      songs: trackRows.map((r) => this.songFromRow(r)),
    };
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.select('SELECT value FROM setting WHERE key = ?', [key]);
    return rows.length > 0 ? toStr(rows[0].value) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }

  async saveAccountRow(account: {
    uin: string;
    nickname: string;
    avatar: string;
    encryptUin: string;
    vipLevel: number;
    keyExpiresAt: number;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO account (uin, nickname, avatar, encrypt_uin, vip_level, key_expires_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uin) DO UPDATE SET
         nickname=excluded.nickname, avatar=excluded.avatar, encrypt_uin=excluded.encrypt_uin,
         vip_level=excluded.vip_level, key_expires_at=excluded.key_expires_at, last_login_at=excluded.last_login_at`,
      [
        account.uin,
        account.nickname,
        account.avatar,
        account.encryptUin,
        account.vipLevel,
        account.keyExpiresAt,
        Date.now(),
      ],
    );
  }

  async clearLocalData(): Promise<void> {
    for (const table of ['play_history', 'daily_recommend', 'playlist_track', 'playlist', 'song', 'cache_entry']) {
      await this.db.execute(`DELETE FROM ${table}`);
    }
  }

  /** 是否已喜欢（缓存判定，离线时也可显示红心） */
  async isLiked(mid: string): Promise<boolean> {
    return (await this.getSetting(`liked:${mid}`)) === '1';
  }

  async setLiked(mid: string, liked: boolean): Promise<void> {
    await this.setSetting(`liked:${mid}`, liked ? '1' : '0');
  }
}

function safeSingers(json: string): Song['singers'] {
  try {
    const parsed = JSON.parse(json);
    return asArr<Record<string, unknown>>(parsed).map((s) => ({
      id: Number(s.id) || 0,
      mid: typeof s.mid === 'string' ? s.mid : '',
      name: typeof s.name === 'string' ? s.name : '',
    }));
  } catch {
    return [];
  }
}
