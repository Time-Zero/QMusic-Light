import { describe, expect, it, vi } from 'vitest';
import type { ApiCallRequest } from '@qmusic/shared-types';
import { QqApi, type ApiTransport } from '../qq/client';
import { createMemoryCache } from '../cache/policy';
import { FeedService } from './feed';

function track(index: number) {
  return {
    mid: `m${index}`,
    id: index,
    name: `song ${index}`,
    interval: 100,
    singer: [{ name: 'singer' }],
    album: { mid: 'am', name: 'album' },
    file: { media_mid: `mm${index}`, size_128mp3: 1 },
  };
}

/** 上游单次最多返回 perPage 首，from 之前的都跳过 */
function radioTransport(perPage: number, max: number) {
  return {
    call: vi.fn(async (request: ApiCallRequest) => {
      const from = Number(request.param.from);
      const end = Math.min(from + perPage, max);
      const tracks = Array.from({ length: Math.max(0, end - from) }, (_, i) => track(from + i));
      return { code: 0, req_0: { code: 0, data: { tracks } } };
    }),
    legacy: vi.fn(async () => ({})),
  } satisfies ApiTransport;
}

describe('FeedService.radio', () => {
  it('按实际返回条数翻页凑够目标数量', async () => {
    const transport = radioTransport(2, 100);
    const service = new FeedService(new QqApi(transport), createMemoryCache(), {} as never);

    const songs = await service.radio(5);
    expect(songs.map((song) => song.mid)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(transport.call).toHaveBeenCalledTimes(3);
    expect(transport.call.mock.calls.map(([request]) => request.param.from)).toEqual([0, 2, 4]);
  });

  it('去重并跳过重复的批次', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => ({ code: 0, req_0: { code: 0, data: { tracks: [track(0), track(1)] } } })),
      legacy: vi.fn(async () => ({})),
    };
    const service = new FeedService(new QqApi(transport), createMemoryCache(), {} as never);

    const songs = await service.radio(5);
    expect(songs).toHaveLength(2);
    // 一直返回同一批时会撞到轮次上限，不会死循环
    expect(transport.call).toHaveBeenCalledTimes(8);
  });

  it('上游没歌时立即返回空数组', async () => {
    const transport: ApiTransport = {
      call: vi.fn(async () => ({ code: 0, req_0: { code: 0, data: { tracks: [] } } })),
      legacy: vi.fn(async () => ({})),
    };
    const service = new FeedService(new QqApi(transport), createMemoryCache(), {} as never);

    expect(await service.radio(10)).toEqual([]);
    expect(transport.call).toHaveBeenCalledTimes(1);
  });
});
