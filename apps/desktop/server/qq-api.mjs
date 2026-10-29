import { APP_CONFIG } from './config.mjs';
import { hash33 } from './hash33.mjs';
import { cookieHeaderFrom, parseJsonLoose } from './net.mjs';

/** 与 packages/core/src/qq/endpoints.ts 对齐的接口白名单（文档 §5.3） */
const ALLOWED = new Set([
  'music.srfDissInfo.DissInfo/CgiGetDiss',
  'music.pf_song_detail_svr/get_song_detail',
  'music.trackInfo.UniformRuleCtrl/CgiGetTrackInfo',
  'music.musichallSong.PlayLyricInfo/GetPlayLyricInfo',
  'music.vkey.GetVkey/UrlGetVkey',
  'music.recommend.RecommendFeed/get_recommend_feed',
  'music.playlist.PlaylistSquare/GetRecommendFeed',
  'music.radioProxy.MbTrackRadioSvr/get_radio_track',
  'music.recommend.TrackRelationServer/GetRadarSong',
  'music.search.SearchCgiService/DoSearchForQQMusicDesktop',
  'music.musicasset.PlaylistBaseRead/GetPlaylistByUin',
  'music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo',
  'music.musicasset.PlaylistDetailWrite/AddSonglist',
  'music.musicasset.PlaylistDetailWrite/DelSonglist',
  'VipLogin.VipLoginInter/vip_login_base',
  'music.login.LoginServer/Login',
]);

const LEGACY_HOSTS = new Set(['c.y.qq.com', 'c6.y.qq.com', 'u.y.qq.com']);

export class PlatformError extends Error {
  constructor(message, code = 500) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
  }
}

function sessionHeaders(credentials, guid) {
  if (credentials) {
    const cookie = cookieHeaderFrom(credentials, guid);
    return { Cookie: cookie };
  }
  return guid ? { Cookie: `guid=${guid}` } : {};
}

/** api.call：comm.uin / qm_keyst 由平台强制覆盖，JS 传入无效（文档 §5.3） */
export async function apiCall(net, credentials, guid, request) {
  const { module, method, param = {}, comm = {} } = request ?? {};
  const key = `${module}/${method}`;
  if (typeof module !== 'string' || typeof method !== 'string' || !ALLOWED.has(key)) {
    throw new PlatformError(`接口不在白名单：${key}`, 403);
  }

  const payload = {
    comm: {
      ct: 24,
      cv: 4747474,
      format: 'json',
      platform: 'yqq.json',
      ...comm,
      uin: credentials ? String(credentials.musicid) : '0',
    },
    req_0: { module, method, param },
  };

  const res = await net.requestWithRetry(APP_CONFIG.musicu, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
      ...sessionHeaders(credentials, guid),
    },
    body: JSON.stringify(payload),
  });
  return parseJsonLoose(await res.text());
}

/** 老 CGI：仅允许 QQ 音乐域名，自动补 g_tk / format */
export async function legacyGet(net, credentials, guid, request) {
  const { path, query = {}, host = 'c.y.qq.com' } = request ?? {};
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('://')) {
    throw new PlatformError('非法的 CGI 路径', 400);
  }
  if (!LEGACY_HOSTS.has(host)) {
    throw new PlatformError(`域名不在白名单：${host}`, 403);
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  if (!params.has('format')) params.set('format', 'json');
  if (!params.has('inCharset')) params.set('inCharset', 'utf8');
  if (!params.has('outCharset')) params.set('outCharset', 'utf-8');
  if (!params.has('platform')) params.set('platform', 'yqq.json');
  if (!params.has('needNewCode')) params.set('needNewCode', '0');
  if (credentials) params.set('g_tk', String(hash33(credentials.musickey, 5381)));

  const url = `https://${host}${path}?${params.toString()}`;
  const res = await net.requestWithRetry(url, {
    headers: { Referer: 'https://y.qq.com/', ...sessionHeaders(credentials, guid) },
  });
  return parseJsonLoose(await res.text());
}
