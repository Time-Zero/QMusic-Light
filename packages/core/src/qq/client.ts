import type { ApiCallRequest, LegacyRequest } from '@qmusic/shared-types';
import { COMM, EP, type Endpoint } from './endpoints';

/** 平台层（Tauri Rust / 本地 Node 服务）暴露的最小传输面 */
export interface ApiTransport {
  call(req: ApiCallRequest): Promise<unknown>;
  legacy(req: LegacyRequest): Promise<unknown>;
}

export class QqApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'QqApiError';
  }
}

export function unwrapCgi(raw: unknown, endpoint: string): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new QqApiError('接口返回空响应', -1, endpoint);
  }
  const root = raw as Record<string, unknown>;
  const outerCode = typeof root.code === 'number' ? root.code : 0;
  if (outerCode !== 0) {
    throw new QqApiError(`接口外层错误 ${outerCode}`, outerCode, endpoint);
  }
  const inner = root.req_0 ?? root.req_1 ?? root;
  const payload = inner as Record<string, unknown>;
  const innerCode = typeof payload.code === 'number' ? payload.code : 0;
  if (innerCode !== 0) {
    // 80030 未登录/uin 不匹配；104009 invalidq —— 都是可识别的业务态
    throw new QqApiError(
      typeof payload.msg === 'string' && payload.msg ? payload.msg : `接口业务错误 ${innerCode}`,
      innerCode,
      endpoint,
    );
  }
  return payload.data ?? payload;
}

export class QqApi {
  constructor(private readonly transport: ApiTransport) {}

  private async call(ep: Endpoint, param: Record<string, unknown>, comm?: Record<string, unknown>) {
    const endpoint = `${ep.module}/${ep.method}`;
    const raw = await this.transport.call({ module: ep.module, method: ep.method, param, comm });
    return unwrapCgi(raw, endpoint);
  }

  diss(disstid: number, opts: { dirid?: number; begin?: number; num?: number; encHostUin?: string } = {}) {
    const param: Record<string, unknown> = {
      disstid,
      dirid: opts.dirid ?? 0,
      tag: 1,
      song_begin: opts.begin ?? 0,
      song_num: opts.num ?? 500,
      userinfo: 1,
      orderlist: 1,
      onlysonglist: 0,
    };
    if (opts.dirid === 201 && opts.encHostUin) param.enc_host_uin = opts.encHostUin;
    return this.call(EP.diss, param);
  }

  songDetail(songMid: string) {
    return this.call(EP.songDetail, { song_mid: songMid });
  }

  tracks(mids: string[]) {
    return this.call(EP.tracks, { mids, types: mids.map(() => 0) });
  }

  lyric(songMid: string, songId = 0) {
    return this.call(EP.lyric, { songMID: songMid, songID: songId });
  }

  vkey(params: {
    filenames: string[];
    songmids: string[];
    songtypes: number[];
    guid: string;
    uin: string;
  }) {
    return this.call(EP.vkey, {
      filename: params.filenames,
      songmid: params.songmids,
      songtype: params.songtypes,
      guid: params.guid,
      uin: params.uin,
      loginflag: 1,
      platform: 20,
    });
  }

  feed(page = 1, comm?: Record<string, unknown>) {
    return this.call(
      EP.feed,
      { direction: 0, page, v_cache: [], v_uniq: [], s_num: 0 },
      comm ?? COMM.web,
    );
  }

  square(from = 0, size = 12) {
    return this.call(EP.square, { From: from, Size: size });
  }

  search(query: string, page = 1, perPage = 30) {
    return this.call(
      EP.search,
      { query, num_per_page: perPage, page_num: page, search_type: 0 },
      COMM.desktop,
    );
  }

  myPlaylists(uin: string) {
    return this.call(EP.myPlaylists, { uin });
  }

  favPlaylists(encryptUin: string, offset = 0, size = 30) {
    return this.call(EP.favPlaylists, { uin: encryptUin, offset, size });
  }

  private async writeLike(ep: Endpoint, song: { mid: string; id: number; songType: number }) {
    return this.call(
      ep,
      {
        dirId: 201,
        v_songInfo: [{ songMid: song.mid, songId: song.id, songType: song.songType }],
      },
      COMM.app,
    );
  }

  addLike(song: { mid: string; id: number; songType: number }) {
    return this.writeLike(EP.likeAdd, song);
  }

  delLike(song: { mid: string; id: number; songType: number }) {
    return this.writeLike(EP.likeDel, song);
  }

  radar(page = 1) {
    return this.call(EP.radar, { Page: page, ReqType: 0 });
  }

  radio(num = 10) {
    return this.call(EP.radio, { id: 99, num, from: 0, scene: 0 });
  }

  vip() {
    return this.call(EP.vip, {});
  }
}
