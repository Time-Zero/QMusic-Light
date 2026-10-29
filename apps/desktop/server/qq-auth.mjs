import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from './config.mjs';
import { hash33 } from './hash33.mjs';
import { Net, cookieHeaderFrom, parseJsonLoose } from './net.mjs';

const QR_TTL = 120 * 1000;

/** ptuiCB('66','0','','0','二维码未失效。', '') —— 注意最后一个参数前可能有空格 */
const PTUI =
  /ptuiCB\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/;

const STATE_BY_CODE = {
  66: 'waiting',
  67: 'scanned',
  65: 'expired',
  68: 'cancelled',
  0: 'confirmed',
};

/**
 * 步骤 1：二维码生成（文档 §3.2 步骤 1）
 * qrsig 落在 ptlogin2.qq.com，必须用带域匹配的 cookie jar。
 */
export async function startQrSession() {
  const net = new Net();
  const url =
    `${APP_CONFIG.loginHost}/ptqrshow?appid=${APP_CONFIG.appId}&e=2&l=M&s=3&d=72&v=4` +
    `&t=${Math.random()}&daid=${APP_CONFIG.daid}&pt_3rd_aid=${APP_CONFIG.thirdAid}`;
  const res = await net.requestWithRetry(url, {
    headers: { Referer: 'https://xui.ptlogin2.qq.com/' },
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const qrsig = net.jar.get('qrsig', `${APP_CONFIG.loginHost}/`) ?? '';
  if (!qrsig) throw new Error('二维码生成失败：未拿到 qrsig');

  return {
    qrId: randomUUID(),
    net,
    qrsig,
    imageDataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + QR_TTL,
    status: 'waiting',
    message: '',
    account: null,
    credentials: null,
  };
}

/** 步骤 2-3：轮询二维码状态 */
export async function pollQrSession(session) {
  if (session.status === 'expired') {
    return { state: 'expired', message: session.message || '二维码已失效' };
  }
  if (session.status === 'cancelled') {
    return { state: 'cancelled', message: session.message || '已取消登录' };
  }
  if (session.status === 'confirmed' && session.account) {
    return { state: 'confirmed', account: session.account };
  }
  if (Date.now() > session.expiresAt) {
    session.status = 'expired';
    return { state: 'expired', message: '二维码已失效' };
  }

  const token = hash33(session.qrsig);
  const url =
    `${APP_CONFIG.loginHost}/ptqrlogin?u1=${encodeURIComponent('https://graph.qq.com/oauth2.0/login_jump')}` +
    `&ptqrtoken=${token}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052` +
    `&action=0-0-${Date.now()}&js_ver=20102616&js_type=1&pt_uistyle=40` +
    `&aid=${APP_CONFIG.appId}&daid=${APP_CONFIG.daid}&pt_3rd_aid=${APP_CONFIG.thirdAid}&has_onekey=1`;

  const res = await session.net.requestWithRetry(url);
  const text = await res.text();
  const match = text.match(PTUI);
  if (!match) {
    throw new Error('二维码状态解析失败');
  }

  const code = match[1];
  const checkUrl = match[3];
  const message = match[5];
  const state = STATE_BY_CODE[code];

  if (!state) {
    session.status = 'cancelled';
    session.message = message || `登录失败（${code}）`;
    return { state: 'cancelled', message: session.message };
  }
  if (state === 'waiting' || state === 'scanned') {
    session.status = state;
    return { state };
  }
  if (state === 'expired' || state === 'cancelled') {
    session.status = state;
    session.message = message;
    return { state, message };
  }

  // code=0：完整链路 check_sig → oauth → QQLogin
  try {
    const result = await completeLogin(session.net, checkUrl);
    session.status = 'confirmed';
    session.account = result.account;
    session.credentials = result.credentials;
    return { state: 'confirmed', account: result.account };
  } catch (error) {
    session.status = 'expired';
    session.message = error instanceof Error ? error.message : '登录失败';
    return { state: 'expired', message: session.message };
  }
}

/** 步骤 4-6：p_skey → code → musickey */
async function completeLogin(net, checkSigUrl) {
  if (!checkSigUrl) throw new Error('登录回调地址为空');
  const parsedCheck = new URL(checkSigUrl);
  const uin = parsedCheck.searchParams.get('uin') ?? '';

  // 4. check_sig：302 并下发 p_skey（graph.qq.com）
  await net.follow(checkSigUrl, {});
  let pSkey = net.jar.get('p_skey', `${APP_CONFIG.graphHost}/`) ?? '';
  if (!pSkey) {
    const retry = await net.requestWithRetry(checkSigUrl, { redirect: 'manual' });
    const location = retry.headers.get('location') ?? '';
    const fromQuery = new URL(location, APP_CONFIG.graphHost).searchParams.get('p_skey');
    if (fromQuery) pSkey = fromQuery;
  }
  if (!pSkey) throw new Error('未获取到 p_skey，登录被中断');

  const gTk = hash33(pSkey, 5381);
  const redirectUri = APP_CONFIG.redirectUri;

  // 5. OAuth authorize：拿到 code
  const form = new URLSearchParams({
    client_id: APP_CONFIG.thirdAid,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'get_user_info,get_app_friends',
    state: randomUUID().replace(/-/g, '').slice(0, 16),
    g_tk: String(gTk),
    ui: randomUUID().replace(/-/g, ''),
    format: 'json',
  });

  let authorized = await net.request(`${APP_CONFIG.graphHost}/oauth2.0/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${APP_CONFIG.graphHost}/`,
    },
    body: form.toString(),
  });

  let location = authorized.headers.get('location') ?? '';
  if (!location) {
    // 某些账号会返回一个自动提交的授权确认页，解析表单后继续
    const html = await authorized.text();
    const next = extractAutoForm(html);
    if (next) {
      authorized = await net.request(next, { method: 'GET' });
      location = authorized.headers.get('location') ?? '';
    }
  }

  let code = '';
  for (let hop = 0; hop < 6 && location; hop++) {
    const url = new URL(location, `${APP_CONFIG.graphHost}/`);
    code = url.searchParams.get('code') ?? code;
    if (code) break;
    if (!url.hostname.endsWith('qq.com')) break;
    const nextRes = await net.request(url.toString(), { method: 'GET', redirect: 'manual' });
    location = nextRes.headers.get('location') ?? '';
  }
  if (!code) throw new Error('未获取到 OAuth code，请稍后重试');

  // 6. QQLogin 换 musickey
  const payload = {
    comm: { ct: 24, cv: 4747474, uin: '0', format: 'json', tmeLoginType: 2 },
    req_0: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: { code },
    },
  };
  const loginRes = await net.request(APP_CONFIG.musicu, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
    body: JSON.stringify(payload),
  });
  const json = parseJsonLoose(await loginRes.text());
  const data = json?.req_0?.data ?? json?.data ?? {};
  const musickey = data.musickey ?? data.musicKey ?? data.qm_keyst ?? '';
  if (!musickey) {
    const msg = json?.req_0?.msg ?? json?.msg ?? 'QQLogin 未返回 musickey';
    throw new Error(String(msg));
  }

  const musicid = String(data.musicid ?? data.str_musicid ?? uin ?? '');
  const createTime = Number(data.musickeyCreateTime ?? Math.floor(Date.now() / 1000));
  const expiresIn = Number(data.keyExpiresIn ?? 7776000);

  const credentials = {
    musicid,
    musickey,
    refreshKey: data.refresh_key ?? '',
    refreshToken: data.refresh_token ?? '',
    accessToken: data.access_token ?? '',
    openid: data.openid ?? '',
    encryptUin: data.encryptUin ?? data.encrypt_uin ?? '',
    keyExpiresIn: expiresIn,
    musickeyCreateTime: createTime,
    keyExpiresAt: (createTime + expiresIn) * 1000,
    savedAt: Date.now(),
  };

  const profile = await fetchProfile(net, credentials);
  const account = {
    uin: musicid,
    nickname: profile.nickname || `QQ ${musicid}`,
    avatar: profile.avatar,
    encryptUin: credentials.encryptUin || profile.encryptUin,
    vipLevel: profile.vipLevel,
    keyExpiresAt: credentials.keyExpiresAt,
    vipLabel: profile.vipLabel,
  };
  credentials.nickname = account.nickname;
  credentials.avatar = account.avatar;
  credentials.vipLevel = account.vipLevel;

  return { account, credentials };
}

function extractAutoForm(html) {
  const action = html.match(/<form[^>]+action="([^"]+)"/i)?.[1];
  if (!action) return '';
  const params = new URLSearchParams();
  const inputRe = /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = inputRe.exec(html))) params.set(m[1], m[2]);
  const base = action.startsWith('http') ? action : `https://graph.qq.com${action}`;
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** 用户资料：老 CGI，g_tk = hash33(musickey, 5381)（文档 §3.4） */
export async function fetchProfile(net, credentials) {
  try {
    const gTk = hash33(credentials.musickey, 5381);
    const query = new URLSearchParams({
      userid: String(credentials.musicid),
      g_tk: String(gTk),
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    });
    const url = `https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?${query.toString()}`;
    const res = await net.requestWithRetry(url, {
      headers: { Cookie: cookieHeaderFrom(credentials) },
    });
    const json = parseJsonLoose(await res.text());
    const creator = json?.data?.creator ?? {};
    const vip = creator.vip ?? {};
    return {
      nickname: creator.nick ?? creator.nickname ?? '',
      avatar: creator.headpic ?? creator.avatar ?? '',
      encryptUin: creator.encrypt_uin ?? creator.encryptUin ?? '',
      vipLevel: Number(vip.vip_level ?? vip.level ?? 0) || 0,
      vipLabel: vip.vip_name ?? vip.name ?? '',
    };
  } catch {
    return { nickname: '', avatar: '', encryptUin: '', vipLevel: 0, vipLabel: '' };
  }
}

/** 静默续期：启动时若距过期 < 24h 则刷新（文档 §3.3） */
export async function refreshCredentials(credentials) {
  const payload = {
    comm: { ct: 24, cv: 4747474, uin: '0', format: 'json' },
    req_0: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        openid: credentials.openid,
        refresh_token: credentials.refreshToken,
        refresh_key: credentials.refreshKey,
        musickey: credentials.musickey,
        loginMode: 2,
        musicid: credentials.musicid,
        access_token: credentials.accessToken,
        expired_in: 0,
      },
    },
  };
  const net = new Net();
  const res = await net.request(APP_CONFIG.musicu, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
      Cookie: cookieHeaderFrom(credentials),
    },
    body: JSON.stringify(payload),
  });
  const json = parseJsonLoose(await res.text());
  const data = json?.req_0?.data ?? json?.data ?? {};
  const musickey = data.musickey ?? '';
  if (!musickey) throw new Error('续期失败');
  const createTime = Number(data.musickeyCreateTime ?? Math.floor(Date.now() / 1000));
  const expiresIn = Number(data.keyExpiresIn ?? credentials.keyExpiresIn ?? 7776000);
  return {
    ...credentials,
    musickey,
    refreshKey: data.refresh_key ?? credentials.refreshKey,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    accessToken: data.access_token ?? credentials.accessToken,
    keyExpiresIn: expiresIn,
    musickeyCreateTime: createTime,
    keyExpiresAt: (createTime + expiresIn) * 1000,
    savedAt: Date.now(),
  };
}

export function shouldRefresh(credentials) {
  const expiresAt = Number(credentials.keyExpiresAt ?? 0);
  if (!expiresAt) return false;
  return Date.now() > expiresAt - 24 * 60 * 60 * 1000;
}

export function accountFromCredentials(credentials) {
  return {
    uin: String(credentials.musicid),
    nickname: credentials.nickname || `QQ ${credentials.musicid}`,
    avatar: credentials.avatar || '',
    encryptUin: credentials.encryptUin || '',
    vipLevel: Number(credentials.vipLevel ?? 0),
    keyExpiresAt: Number(credentials.keyExpiresAt ?? 0),
    vipLabel: credentials.vipLabel || '',
  };
}
