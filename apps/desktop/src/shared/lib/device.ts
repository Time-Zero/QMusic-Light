const KEY = 'qmusic:guid';

/**
 * guid 是设备标识，参与风控，必须持久化且稳定（文档 §3.2 坑 2）。
 * 与 OAuth 页面用的 `ui` 不同，后者每次随机。
 */
export function deviceGuid(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const guid = crypto.randomUUID();
    localStorage.setItem(KEY, guid);
    return guid;
  } catch {
    return '00000000-0000-4000-8000-000000000000';
  }
}
