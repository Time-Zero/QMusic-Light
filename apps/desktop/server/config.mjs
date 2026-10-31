import fs from 'node:fs';
import path from 'node:path';

/** 本地数据目录：DB、设备 guid、凭证。不进入版本库。 */
export const DATA_DIR = process.env.QMUSIC_DATA_DIR
  ? path.resolve(process.env.QMUSIC_DATA_DIR)
  : path.resolve(process.cwd(), '.data');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function dataFile(name) {
  ensureDataDir();
  return path.join(DATA_DIR, name);
}

export const APP_CONFIG = {
  appId: '716027609',
  daid: '383',
  thirdAid: '100497308',
  loginHost: 'https://ssl.ptlogin2.qq.com',
  xloginHost: 'https://xui.ptlogin2.qq.com/',
  xlogin: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin',
  graphHost: 'https://graph.qq.com',
  musicu: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
  redirectUri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F',
  ua: 'QMusicLite/0.1 (Windows)',
};
