import fs from 'node:fs';
import { dataFile } from './config.mjs';

/**
 * 凭证存储。Tauri 版由 `keyring` 写入系统钥匙串（文档 §6.2）；
 * 本地 Node 平台层退化为用户目录下的私有文件，权限 0600，永不进日志。
 */
const FILE = () => dataFile('credentials.json');

export function loadCredentials() {
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.musickey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials) {
  const file = FILE();
  fs.writeFileSync(file, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 可能无效，忽略
  }
}

export function clearCredentials() {
  try {
    fs.unlinkSync(FILE());
  } catch {
    // 文件不存在即已清空
  }
}

/** 日志脱敏：qm_keyst / refresh_token / openid 永不落日志（文档 §9.1） */
export function maskSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '')
    .replace(/(qm_keyst|qqmusic_key|musickey)=([^;]+)/g, '$1=***')
    .replace(/"(musickey|refresh_key|refresh_token|access_token|openid)"\s*:\s*"[^"]*"/g, '"$1":"***"');
}
