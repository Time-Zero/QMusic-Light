import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from './config.mjs';
import { Db } from './db.mjs';
import { Net } from './net.mjs';
import { apiCall, legacyGet, PlatformError } from './qq-api.mjs';
import {
  accountFromCredentials,
  fetchProfile,
  pollQrSession,
  refreshCredentials,
  shouldRefresh,
  startQrSession,
} from './qq-auth.mjs';
import { clearCredentials, loadCredentials, saveCredentials } from './secret.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const QR_KEEP = 5 * 60 * 1000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new PlatformError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new PlatformError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function loadGuid() {
  try {
    const existing = fs.readFileSync(dataFile('guid'), 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 首次启动
  }
  const guid = randomUUID();
  fs.writeFileSync(dataFile('guid'), guid, 'utf8');
  return guid;
}

export function createPlatform() {
  const db = new Db();
  const net = new Net();
  const guid = loadGuid();
  /** @type {Map<string, Awaited<ReturnType<typeof startQrSession>>>} */
  const qrSessions = new Map();

  let credentials = loadCredentials();
  let account = credentials ? accountFromCredentials(credentials) : null;
  let restoreTask = null;

  async function restore() {
    if (restoreTask) return restoreTask;
    restoreTask = (async () => {
      if (!credentials) return {};
      try {
        if (shouldRefresh(credentials)) {
          try {
            credentials = await refreshCredentials(credentials);
            saveCredentials(credentials);
          } catch {
            return { expired: true, account };
          }
        }
        account = accountFromCredentials(credentials);
        if (!account.nickname || account.nickname === `QQ ${account.uin}`) {
          const profile = await fetchProfile(net, credentials);
          account = {
            ...account,
            nickname: profile.nickname || account.nickname,
            avatar: profile.avatar || account.avatar,
            encryptUin: profile.encryptUin || account.encryptUin,
            vipLevel: profile.vipLevel,
            vipLabel: profile.vipLabel,
          };
          credentials = { ...credentials, ...account };
          saveCredentials(credentials);
        }
        db.execute(
          `INSERT INTO account (uin, nickname, avatar, encrypt_uin, vip_level, key_expires_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uin) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar,
             encrypt_uin=excluded.encrypt_uin, vip_level=excluded.vip_level,
             key_expires_at=excluded.key_expires_at, last_login_at=excluded.last_login_at`,
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
        return { account };
      } catch {
        return { expired: true };
      }
    })();
    return restoreTask;
  }

  function pruneQrSessions() {
    const now = Date.now();
    for (const [id, session] of qrSessions) {
      if (now - session.createdAt > QR_KEEP) qrSessions.delete(id);
    }
  }

  async function handleQrStart() {
    pruneQrSessions();
    const session = await startQrSession();
    qrSessions.set(session.qrId, session);
    return {
      qrId: session.qrId,
      imageDataUrl: session.imageDataUrl,
      expiresAt: session.expiresAt,
    };
  }

  async function handleQrPoll(qrId) {
    const session = qrSessions.get(qrId);
    if (!session) return { state: 'expired', message: '二维码会话已失效，请刷新' };
    const result = await pollQrSession(session);
    if (result.state === 'confirmed' && session.credentials) {
      credentials = session.credentials;
      account = session.account;
      saveCredentials(credentials);
      restoreTask = null;
      if (account) {
        db.execute(
          `INSERT INTO account (uin, nickname, avatar, encrypt_uin, vip_level, key_expires_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uin) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar,
             encrypt_uin=excluded.encrypt_uin, vip_level=excluded.vip_level,
             key_expires_at=excluded.key_expires_at, last_login_at=excluded.last_login_at`,
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
      for (const id of qrSessions.keys()) {
        if (id !== qrId) qrSessions.delete(id);
      }
    }
    return result;
  }

  async function route(url, body) {
    switch (url) {
      case '/auth/qr_start':
        return handleQrStart();

      case '/auth/qr_poll':
        return handleQrPoll(body.qrId);

      case '/auth/restore':
        return restore();

      case '/auth/logout':
        clearCredentials();
        credentials = null;
        account = null;
        restoreTask = null;
        qrSessions.clear();
        return {};

      case '/api/call':
        if (!body || typeof body.module !== 'string') throw new PlatformError('缺少 module', 400);
        return apiCall(net, credentials, guid, body);

      case '/api/legacy':
        return legacyGet(net, credentials, guid, body);

      case '/db/select':
        return db.select(body.sql, body.params ?? []);

      case '/db/execute':
        return db.execute(body.sql, body.params ?? []);

      case '/sys/info':
        return {
          version: '0.1.0',
          webview: `Node ${process.version}`,
          platform: `${process.platform} ${process.arch}`,
          runtime: 'browser',
        };

      case '/health':
        return { ok: true, loggedIn: Boolean(credentials), guid };

      default:
        throw new PlatformError('未知的 IPC 命令', 404);
    }
  }

  async function handle(req, res) {
    const url = (req.url ?? '').split('?')[0].replace(/^\/__api/, '');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: { message: 'Method Not Allowed', code: 405 } });
      return;
    }
    try {
      const body = await readJson(req);
      const data = await route(url, body);
      send(res, 200, { ok: true, data });
    } catch (error) {
      const code = error instanceof PlatformError ? error.code : 500;
      const message = error instanceof Error ? error.message : '平台层异常';
      send(res, 200, { ok: false, error: { message, code } });
    }
  }

  return { handle, db, restore, close: () => db.close() };
}
