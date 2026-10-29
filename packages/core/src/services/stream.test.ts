import { describe, expect, it, vi } from 'vitest';
import type { Song } from '@qmusic/shared-types';
import { QqApi, type ApiTransport } from '../qq/client';
import { createMemoryCache } from '../cache/policy';
import { StreamService, StreamUnavailableError, buildFilename, streamChain } from './stream';

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    mid: 'songmid',
    id: 1,
    name: '歌',
    title: '歌',
    albumMid: '',
    albumName: '',
    singers: [],
    cover: '',
    duration: 200,
    mediaMid: 'mediamid',
    payPlay: 0,
    playable: true,
    songType: 0,
    ...overrides,
  };
}

function transportWith(handler: (request: Record<string, unknown>) => unknown): ApiTransport {
  return {
    call: vi.fn(async (request) => handler(request as unknown as Record<string, unknown>)),
    legacy: vi.fn(async () => ({})),
  };
}

function vkeyResponse(purl: string) {
  return {
    code: 0,
    req_0: {
      code: 0,
      data: {
        sip: ['https://isure.stream.qqmusic.qq.com/'],
        midurlinfo: [{ purl }],
      },
    },
  };
}

describe('filename 拼装', () => {
  it('mid 重复两次，并按音质选择前缀与后缀', () => {
    expect(buildFilename({ mid: 'abc', mediaMid: 'abc' }, '320')).toBe('M800abcabc.mp3');
    expect(buildFilename({ mid: 'abc', mediaMid: 'mm' }, 'flac')).toBe('F000mmmm.flac');
    expect(buildFilename({ mid: 'abc', mediaMid: 'abc' }, '128')).toBe('M500abcabc.mp3');
    expect(buildFilename({ mid: 'abc', mediaMid: 'abc' }, 'aac')).toBe('C400abcabc.m4a');
  });
});

describe('音质降级链', () => {
  it('从首选音质开始，且不超过曲目最高音质', () => {
    expect(streamChain('flac', { maxQuality: '320' })).toEqual(['320', '128', 'aac']);
    expect(streamChain('320', { maxQuality: 'flac' })).toEqual(['320', '128', 'aac']);
    expect(streamChain('flac', {})).toEqual(['flac', '320', '128', 'aac']);
    expect(streamChain('128', { maxQuality: '128' })).toEqual(['128', 'aac']);
    expect(streamChain('flac', { maxQuality: 'flac' })).toEqual(['flac', '320', '128', 'aac']);
  });
});

describe('StreamService', () => {
  it('返回拼好的直链与音质', async () => {
    const transport = transportWith(() => vkeyResponse('M800songmidsongmid.mp3?vkey=1'));
    const service = new StreamService(new QqApi(transport), createMemoryCache(), () => ({
      guid: 'g',
      uin: '0',
      quality: '320',
    }));

    const info = await service.resolve(makeSong());
    expect(info.url).toBe('https://isure.stream.qqmusic.qq.com/M800songmidsongmid.mp3?vkey=1');
    expect(info.quality).toBe('320');
    expect(info.expiresAt).toBeGreaterThan(Date.now());
  });

  it('purl 为空时降级重试', async () => {
    const calls: string[] = [];
    const transport = transportWith((request) => {
      const param = (request as unknown as { param: { filename: string[] } }).param;
      const filename = param.filename[0];
      calls.push(filename);
      return vkeyResponse(filename.startsWith('M500') ? 'ok-128.mp3' : '');
    });
    const service = new StreamService(new QqApi(transport), createMemoryCache(), () => ({
      guid: 'g',
      uin: 'u',
      quality: '320',
    }));

    const info = await service.resolve(makeSong());
    expect(calls).toEqual(['M800mediamidmediamid.mp3', 'M500mediamidmediamid.mp3']);
    expect(info.quality).toBe('128');
    expect(info.url).toContain('ok-128.mp3');
  });

  it('全部音质都拿不到 purl 时抛出无版权错误', async () => {
    const transport = transportWith(() => vkeyResponse(''));
    const service = new StreamService(new QqApi(transport), createMemoryCache(), () => ({
      guid: 'g',
      uin: '0',
    }));

    await expect(service.resolve(makeSong())).rejects.toBeInstanceOf(StreamUnavailableError);
  });

  it('20 分钟内命中缓存，不重复请求', async () => {
    const transport = transportWith(() => vkeyResponse('cached.mp3'));
    const service = new StreamService(new QqApi(transport), createMemoryCache(), () => ({
      guid: 'g',
      uin: '0',
    }));

    const first = await service.resolve(makeSong());
    const second = await service.resolve(makeSong());
    expect(second.url).toBe(first.url);
    expect(transport.call).toHaveBeenCalledTimes(1);
  });
});
