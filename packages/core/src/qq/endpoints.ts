/** QQ 音乐统一 CGI 接口清单（文档 §3.4） */

export interface Endpoint {
  module: string;
  method: string;
}

export const EP = {
  diss: { module: 'music.srfDissInfo.DissInfo', method: 'CgiGetDiss' },
  songDetail: { module: 'music.pf_song_detail_svr', method: 'get_song_detail' },
  tracks: { module: 'music.trackInfo.UniformRuleCtrl', method: 'CgiGetTrackInfo' },
  lyric: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo' },
  vkey: { module: 'music.vkey.GetVkey', method: 'UrlGetVkey' },
  feed: { module: 'music.recommend.RecommendFeed', method: 'get_recommend_feed' },
  square: { module: 'music.playlist.PlaylistSquare', method: 'GetRecommendFeed' },
  radio: { module: 'music.radioProxy.MbTrackRadioSvr', method: 'get_radio_track' },
  radar: { module: 'music.recommend.TrackRelationServer', method: 'GetRadarSong' },
  search: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop' },
  myPlaylists: { module: 'music.musicasset.PlaylistBaseRead', method: 'GetPlaylistByUin' },
  favPlaylists: { module: 'music.musicasset.PlaylistFavRead', method: 'CgiGetPlaylistFavInfo' },
  likeAdd: { module: 'music.musicasset.PlaylistDetailWrite', method: 'AddSonglist' },
  likeDel: { module: 'music.musicasset.PlaylistDetailWrite', method: 'DelSonglist' },
  vip: { module: 'VipLogin.VipLoginInter', method: 'vip_login_base' },
} satisfies Record<string, Endpoint>;

/** comm 决定"像哪个客户端"（文档 §3.1） */
export const COMM = {
  web: { ct: 24, cv: 4747474, platform: 'yqq.json' },
  desktop: { ct: 19, cv: 2201 },
  /** 写"我喜欢"、移动端推荐流必须用 App comm，否则 80105 */
  app: { ct: 11, cv: 13020508, tmeAppID: 'qqmusic' },
} as const;

/** 平台层白名单：渲染层被 XSS 后不能把 api.call 当任意代理（文档 §5.3） */
export const API_ALLOWLIST: ReadonlySet<string> = new Set(
  Object.values(EP).map((e) => `${e.module}/${e.method}`),
);

/** 稳定封面地址：按显示尺寸取图，别直接拿原图（文档 §8.2） */
export function albumCoverUrl(albumMid: string, size = 300): string {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`;
}

export function playlistCoverUrl(raw?: string): string {
  if (!raw) return '';
  return raw.replace(/^http:\/\//, 'https://');
}
