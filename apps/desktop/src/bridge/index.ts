import type {
  Account,
  ApiCallRequest,
  CachedStream,
  DbResult,
  DbValue,
  LegacyRequest,
  QrPollResult,
  QrStartResult,
  RestoreResult,
  ShellSettings,
  StreamCacheStats,
  SysInfo,
} from '@qmusic/shared-types';

/**
 * IPC 契约（文档 §5.3）。Tauri 下走 invoke，本地开发走 /__api（Node 平台层）。
 * 两边命令名一一对应：auth.qr_start / api.call / db.select ...
 * Tauri 命令名不能带点号，因此由单一 `ipc` 命令在 Rust 侧按点号分发。
 */

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code = 500,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export const IS_TAURI =
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);

/** 桌面歌词浮窗里的一行歌词（与 `LyricLine` 同构，跨 IPC 时不带 undefined） */
export interface LyricLinePayload {
  time: number;
  text: string;
  trans: string;
}

export interface LyricSongPayload {
  name: string;
  singers: string;
  cover: string | null;
}

/**
 * 桌面歌词快照。主窗口只推增量（换歌 / 换行 / 播放态），
 * Rust 侧合并成完整快照再广播给歌词窗口，所以任何一边先起来都能对上。
 */
export interface LyricSnapshot {
  song: LyricSongPayload | null;
  lines: LyricLinePayload[];
  /** 当前高亮行；-1 表示还没进第一句（或没有歌词） */
  index: number;
  playing: boolean;
}

export type LyricPatch = Partial<LyricSnapshot>;

export type LyricAction = 'toggle' | 'prev' | 'next';

function tauriCommandFor(path: string): string {
  // '/auth/qr_start' → 'auth.qr_start'，与 Node 平台层路由逐段对应
  return path.replace(/^\/+/, '').replace(/\//g, '.');
}

async function invokeTauri<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
    }
  ).__TAURI_INTERNALS__;
  try {
    return await internals.invoke('ipc', { command: tauriCommandFor(path), args });
  } catch (error) {
    // Tauri 的 reject 值是字符串，统一成 Error，避免上层只能显示「初始化失败」
    if (error instanceof Error) throw new BridgeError(error.message);
    if (typeof error === 'string') throw new BridgeError(error);
    throw new BridgeError('平台层调用失败');
  }
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/__api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BridgeError('本地平台层未启动，请使用 npm run dev / npm run preview 启动应用');
  }
  if (!response.ok) {
    throw new BridgeError(`平台层返回 ${response.status}`);
  }
  const json = (await response.json()) as {
    ok: boolean;
    data?: T;
    error?: { message?: string; code?: number };
  };
  if (!json.ok) throw new BridgeError(json.error?.message ?? '平台层调用失败', json.error?.code ?? 500);
  return json.data as T;
}

async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  if (IS_TAURI) {
    return invokeTauri<T>(path, body);
  }
  return post<T>(path, body);
}

export const bridge = {
  isTauri: IS_TAURI,
  auth: {
    start: (kind: 'qq' | 'wx' = 'qq') => call<QrStartResult>('/auth/qr_start', { kind }),
    poll: (qrId: string) => call<QrPollResult>('/auth/qr_poll', { qrId }),
    restore: () => call<RestoreResult>('/auth/restore'),
    logout: () => call<void>('/auth/logout'),
  },
  api: {
    call: (request: ApiCallRequest) =>
      call<unknown>('/api/call', request as unknown as Record<string, unknown>),
    legacy: (request: LegacyRequest) =>
      call<unknown>('/api/legacy', request as unknown as Record<string, unknown>),
  },
  sys: {
    info: () => call<SysInfo>('/sys/info'),
  },
  /** 窗口 / 托盘 / 缓存偏好：Rust 侧持久化，启动时就要读到 */
  settings: {
    get: () => call<ShellSettings>('/app/settings'),
    update: (patch: ShellPrefsPatch) =>
      call<ShellSettings>('/app/prefs_update', patch as Record<string, unknown>),
    traySync: (payload: { title: string; playing: boolean }) =>
      call<void>('/app/tray_sync', payload),
    /** 原生「选择文件夹」对话框；取消时 path 为 null */
    pickDir: () => call<{ path: string | null }>('/app/pick_dir'),
    show: () => call<void>('/app/show'),
    quit: () => call<void>('/app/quit'),
  },
  /**
   * 桌面浮动歌词：窗口由 Rust 侧创建与摆放，前端只负责开关与推快照。
   * 同一个窗口在一生中只建一次，关掉只是隐藏，再开立刻接上当前句。
   */
  lyric: {
    setEnabled: (enabled: boolean) => call<{ enabled: boolean }>('/lyric/set_enabled', { enabled }),
    /** 歌词窗口挂载时补一次完整快照，避免首帧空白 */
    snapshot: () => call<LyricSnapshot>('/lyric/snapshot'),
    sync: (patch: LyricPatch) => call<LyricSnapshot>('/lyric/sync', patch as Record<string, unknown>),
    action: (action: LyricAction) => call<void>('/lyric/action', { action }),
    persistPos: (pos: { x: number; y: number }) => call<void>('/lyric/persist_pos', pos),
  },
  /** 整首音频缓存：命中即本地回放，网络波动不影响播放 */
  cache: {
    get: (key: string, ext: string) => call<CachedStream | null>('/cache/get', { key, ext }),
    prefetch: (payload: { key: string; url: string; ext: string }) =>
      call<CachedStream | null>('/cache/prefetch', payload),
    cancel: (key: string, ext: string) => call<void>('/cache/cancel', { key, ext }),
    stats: () => call<StreamCacheStats>('/cache/stats'),
    clear: () => call<StreamCacheStats>('/cache/clear'),
  },
  db: {
    select: async (sql: string, params: DbValue[] = []): Promise<Record<string, DbValue>[]> => {
      const result = await call<DbResult | Record<string, DbValue>[]>('/db/select', { sql, params });
      return Array.isArray(result) ? result : (result.rows ?? []);
    },
    execute: async (sql: string, params: DbValue[] = []): Promise<number> => {
      const result = await call<DbResult | number>('/db/execute', { sql, params });
      return typeof result === 'number' ? result : (result.changes ?? 0);
    },
  },
};

export type Bridge = typeof bridge;
export type BridgeAccount = Account;

/** 可写偏好：占用统计等派生字段由平台层返回，不接受前端写入 */
export type ShellPrefsPatch = Partial<
  Pick<ShellSettings, 'closeAction' | 'minimizeToTray' | 'streamCache' | 'cacheDir' | 'cacheMaxBytes'>
>;
