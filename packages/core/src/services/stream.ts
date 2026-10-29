import {
  QUALITY_CHAIN,
  type Quality,
  type Song,
  type StreamInfo,
} from '@qmusic/shared-types';
import type { QqApi } from '../qq/client';
import { asArr, asObj, num, str } from '../qq/mappers';
import { TTL, type CacheStore } from '../cache/policy';

const FILE_META: Record<Quality, { prefix: string; ext: string }> = {
  flac: { prefix: 'F000', ext: 'flac' },
  '320': { prefix: 'M800', ext: 'mp3' },
  '128': { prefix: 'M500', ext: 'mp3' },
  aac: { prefix: 'C400', ext: 'm4a' },
};

const QUALITY_ORDER: Quality[] = [...QUALITY_CHAIN, 'aac'];
const DEFAULT_SIP = 'https://isure.stream.qqmusic.qq.com/';

export class StreamUnavailableError extends Error {
  constructor(
    message: string,
    readonly mid: string,
  ) {
    super(message);
    this.name = 'StreamUnavailableError';
  }
}

/** filename = <prefix><media_mid><media_mid><ext>，mid 重复两次是协议要求（文档 §3.5） */
export function buildFilename(song: Pick<Song, 'mid' | 'mediaMid'>, quality: Quality): string {
  const meta = FILE_META[quality];
  const mediaMid = song.mediaMid || song.mid;
  return `${meta.prefix}${mediaMid}${mediaMid}.${meta.ext}`;
}

export function streamChain(preferred: Quality, song: Pick<Song, 'maxQuality'>): Quality[] {
  const start = Math.max(QUALITY_ORDER.indexOf(preferred), 0);
  const candidates = QUALITY_ORDER.slice(start);
  // maxQuality 未知时不做上限裁剪；已知时只允许「不高于该音质」的降级
  const capIndex = song.maxQuality ? QUALITY_ORDER.indexOf(song.maxQuality) : -1;
  return capIndex >= 0
    ? candidates.filter((quality) => QUALITY_ORDER.indexOf(quality) >= capIndex)
    : candidates;
}

export interface StreamResolverOptions {
  guid: string;
  uin: string;
  /** 用户设置的首选音质 */
  quality?: Quality;
}

export class StreamService {
  constructor(
    private readonly api: QqApi,
    private readonly cache: CacheStore,
    private readonly getOptions: () => StreamResolverOptions,
  ) {}

  async resolve(song: Song, quality?: Quality): Promise<StreamInfo> {
    const options = this.getOptions();
    const preferred = quality ?? options.quality ?? '320';
    const key = `stream:${song.mid}:${preferred}`;
    const cached = this.cache.get<StreamInfo>(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const chain = streamChain(preferred, song);
    let lastMessage = '无版权或需要会员';

    for (const q of chain) {
      try {
        const data = asObj(
          await this.api.vkey({
            filenames: [buildFilename(song, q)],
            songmids: [song.mid],
            songtypes: [song.songType || 0],
            guid: options.guid,
            uin: options.uin,
          }),
        );
        const info = asObj(asArr(data.midurlinfo)[0]);
        const purl = str(info.purl);
        const retcode = num(info.result, data.retcode);
        if (retcode !== 0 && !purl) {
          lastMessage = str(info.errtype, info.msg) || lastMessage;
          continue;
        }
        if (!purl) {
          lastMessage = str(info.errtype, info.msg) || lastMessage;
          continue;
        }
        const sip = str(asArr<string>(data.sip)[0], DEFAULT_SIP);
        const base = sip.endsWith('/') ? sip : `${sip}/`;
        const url = /^https?:\/\//.test(purl) ? purl : `${base}${purl.replace(/^\//, '')}`;
        const infoResult: StreamInfo = {
          url,
          quality: q,
          expiresAt: Date.now() + TTL.stream,
          trial: false,
        };
        this.cache.set(key, infoResult, TTL.stream);
        return infoResult;
      } catch (error) {
        if (error instanceof Error) lastMessage = error.message;
      }
    }

    throw new StreamUnavailableError(lastMessage, song.mid);
  }

  /** 403 时立即失效重取（文档 §5.4） */
  invalidate(song: Song) {
    for (const q of QUALITY_ORDER) this.cache.delete(`stream:${song.mid}:${q}`);
  }
}
