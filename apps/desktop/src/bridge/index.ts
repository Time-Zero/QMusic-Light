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

/** 播放控制动作：托盘、桌面歌词、任务栏面板共用同一条原生通道 */
export type PlaybackAction = 'toggle' | 'prev' | 'next';
export type LyricAction = PlaybackAction;

/** 任务栏面板里的当前曲目：只要封面，不要歌词 */
export interface TaskbarSongPayload {
  name: string;
  singers: string;
  cover: string | null;
}

/**
 * 任务栏面板的排布参数，全部由平台侧按任务栏实测尺寸下发：
 * `h` 是胶囊高度（所有控件按它等比缩放），`pad` 是窗口四周给投影留的空白，
 * `axis` 决定胶囊横排还是竖排（任务栏停靠在屏幕左右两侧时竖过来）。
 */
export interface TaskbarLayout {
  h: number;
  pad: number;
  axis: 'horizontal' | 'vertical';
  /** 跟随 Windows 的明暗模式，而不是应用内主题 */
  theme: 'light' | 'dark';
}

export interface TaskbarSnapshot {
  song: TaskbarSongPayload | null;
  playing: boolean;
  layout: TaskbarLayout;
}

export type TaskbarPatch = Partial<Pick<TaskbarSnapshot, 'song' | 'playing'>>;

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
  /**
   * 任务栏播放控制面板：窗口由平台侧创建、定位、跟随任务栏，
   * 前端只推「封面 + 播放态」，并在画完第一帧后报到（`ready`）让窗口露面。
   */
  taskbar: {
    /** 面板挂载时补读一次：播放态 + 当前任务栏比例 */
    snapshot: () => call<TaskbarSnapshot>('/taskbar/snapshot'),
    sync: (patch: TaskbarPatch) => call<void>('/taskbar/sync', patch as Record<string, unknown>),
    /** 首帧已就绪：平台侧此时才把窗口显示出来，避免白底 / 错主题闪一下 */
    ready: () => call<void>('/taskbar/ready'),
    action: (action: PlaybackAction) => call<void>('/taskbar/action', { action }),
    /** 点封面回主界面：面板贴在任务栏上，点封面就是想把它叫回来 */
    focusMain: () => call<void>('/taskbar/focus_main'),
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
  Pick<
    ShellSettings,
    | 'closeAction'
    | 'minimizeToTray'
    | 'taskbarPanel'
    | 'taskbarShift'
    | 'streamCache'
    | 'cacheDir'
    | 'cacheMaxBytes'
  >
>;
