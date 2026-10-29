import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@qmusic/shared-types';
import { QqApi, type ApiTransport } from '../qq/client';
import { createMemoryCache } from '../cache/policy';
import { PlaylistService } from './playlist';
import { SearchService } from './search';

const account: Account = {
  uin: '10001',
  nickname: 'tester',
  avatar: '',
  encryptUin: 'enc**',
  vipLevel: 0,
  keyExpiresAt: 0,
};

function dissResponse(songs: unknown[] = [], total = songs.length) {
  return {
    code: 0,
    req_0: {
      code: 0,
      data: {
        dirinfo: { id: 0, dirid: 201, title: '我喜欢的音乐', songnum: total, listennum: 3 },
        songlist: songs,
        total_song_num: total,
      },
    },
  };
}

const oneSong = {
  mid: 'm1',
  id: 1,
  name: 'song',
  interval: 100,
  singer: [{ name: 'singer' }],
  album: { mid: 'am', name: 'album' },
  file: { media_mid: 'mm', size_128mp3: 1 },
};

describe('PlaylistService', () => {
  it('「我喜欢」使用 disstid=0 + dirid=201 + enc_host_uin', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => dissResponse([oneSong], 1)),
      legacy: vi.fn(async () => ({})),
    };
    const service = new PlaylistService(new QqApi(transport), createMemoryCache());

    const detail = await service.liked(account);
    expect(detail.playlist.title).toBe('我喜欢的音乐');
    expect(detail.playlist.id).toBe(0);
    expect(detail.songs).toHaveLength(1);

    const request = (transport.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.param.disstid).toBe(0);
    expect(request.param.dirid).toBe(201);
    expect(request.param.enc_host_uin).toBe('enc**');
  });

  it('歌单详情缓存 10 分钟，重复调用不重复请求', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => dissResponse([oneSong], 40)),
      legacy: vi.fn(async () => ({})),
    };
    const service = new PlaylistService(new QqApi(transport), createMemoryCache());

    const first = await service.detail(42);
    const second = await service.detail(42);
    expect(second.playlist.title).toBe(first.playlist.title);
    expect(transport.call).toHaveBeenCalledTimes(1);
  });

  it('单次 song_num 不超过 500', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => dissResponse()),
      legacy: vi.fn(async () => ({})),
    };
    const service = new PlaylistService(new QqApi(transport), createMemoryCache());
    await service.detail(7, { num: 2000 });
    const request = (transport.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.param.song_num).toBe(500);
  });
});

describe('SearchService', () => {
  it('搜索 2001 时返回空结果而不是抛错', async () => {
    let attempts = 0;
    const transport: ApiTransport = {
      call: vi.fn(async () => {
        attempts += 1;
        return { code: 0, req_0: { code: 2001, msg: 'need login' } };
      }),
      legacy: vi.fn(async () => ({})),
    };
    const service = new SearchService(new QqApi(transport), transport);
    const result = await service.all('周杰伦', 1, 30);
    expect(result.songs.items).toEqual([]);
    expect(result.playlists.items).toEqual([]);
    expect(attempts).toBe(2);
  });

  it('正常返回单曲/歌单/歌手', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => ({
        code: 0,
        req_0: {
          code: 0,
          data: {
            body: {
              song: { list: [oneSong] },
              songlist: { list: [{ tid: 9, title: 'pl', song_cnt: 3, creator: { nick: 'u' } }] },
              singer: { list: [{ mid: 'sm', name: 'singer' }] },
              meta: { sum: 10 },
            },
            meta: { sum: 10 },
          },
        },
      })),
      legacy: vi.fn(async () => ({})),
    };
    const service = new SearchService(new QqApi(transport), transport);
    const result = await service.all('jay');
    expect(result.songs.items).toHaveLength(1);
    expect(result.playlists.items[0].id).toBe(9);
    expect(result.singers.items[0].name).toBe('singer');
  });
});
