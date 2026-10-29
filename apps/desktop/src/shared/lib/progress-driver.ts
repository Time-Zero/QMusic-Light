/**
 * 播放进度的单帧循环。
 *
 * 为什么不直接用 timeupdate：
 *   1. 它约 4 Hz 才来一次，直接喂 UI 会得到"每秒跳四下"的进度条；
 *   2. 用它驱动 React 状态，每来一次都要重渲染整棵播放条与歌词列表。
 *
 * 这里用一条 rAF 循环 + 单调时钟外推补帧：帧间按 elapsed 推算当前播放位置，
 * 下一个 timeupdate 到来时把锚点校正回来（漂移被限制在 ±16ms 内）。
 * 循环里只调用订阅者写样式，不碰 React、不读布局。
 */

export interface ProgressSnapshot {
  /** 外推后的当前播放位置（秒）。 */
  seconds: number;
  /** 音频总时长；元数据未就绪时为 0。 */
  duration: number;
  playing: boolean;
}

export type ProgressSink = (snapshot: ProgressSnapshot) => void;

const sinks = new Set<ProgressSink>();

let audio: HTMLAudioElement | null = null;
let frame = 0;
let boundElement: HTMLAudioElement | null = null;

/** 锚点：audio.currentTime 在某个单调时钟时刻的值。 */
let anchor: PlaybackAnchor = { time: 0, at: 0 };

export interface PlaybackAnchor {
  /** 采样时刻的 audio.currentTime（秒）。 */
  time: number;
  /** 采样时刻的 performance.now()（毫秒）。 */
  at: number;
}

/**
 * 帧间外推：以 timeupdate 采样点为锚，用单调时钟补出当前播放位置。
 *
 * 抽成纯函数是为了能直接测：这段每帧都在跑，错一次就是进度条乱跳。
 * 漂移由下一个 timeupdate 重新对齐锚点消除，所以这里不需要考虑累积误差。
 */
export function estimateSeconds(input: {
  anchor: PlaybackAnchor;
  /** 当前帧的单调时钟（毫秒）。 */
  clock: number;
  paused: boolean;
  /** 暂停时以元素真实值为准。 */
  currentTime: number;
  /** 总时长；未知时传 0。 */
  duration: number;
}): number {
  if (input.paused) return Math.max(0, input.currentTime);
  const estimated = input.anchor.time + (input.clock - input.anchor.at) / 1000;
  const clamped = Math.max(0, estimated);
  return input.duration > 0 ? Math.min(clamped, input.duration) : clamped;
}

function durationOf(): number {
  const value = audio?.duration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function secondsAt(clock: number): number {
  if (!audio) return 0;
  return estimateSeconds({
    anchor,
    clock,
    paused: audio.paused,
    currentTime: audio.currentTime,
    duration: durationOf(),
  });
}

function emit(clock = performance.now()): void {
  if (!audio) return;
  const snapshot: ProgressSnapshot = {
    seconds: secondsAt(clock),
    duration: durationOf(),
    playing: !audio.paused,
  };
  for (const sink of sinks) sink(snapshot);
}

function tick(clock: number): void {
  frame = 0;
  emit(clock);
  if (audio && !audio.paused) frame = requestAnimationFrame(tick);
}

/** 记录新的锚点。currentTime 是普通属性读取，不触发布局。 */
function sample(): void {
  if (!audio) return;
  anchor = { time: audio.currentTime, at: performance.now() };
}

function start(): void {
  if (frame || !audio || audio.paused) return;
  frame = requestAnimationFrame(tick);
}

function stop(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  emit();
}

/**
 * 订阅逐帧进度。订阅时会立刻收到一次当前值，供刚挂载的控件初始化。
 * 返回退订函数。
 */
export function subscribeProgress(sink: ProgressSink): () => void {
  sinks.add(sink);
  if (audio) sink({ seconds: audio.currentTime, duration: durationOf(), playing: !audio.paused });
  return () => {
    sinks.delete(sink);
  };
}

/**
 * 把驱动挂到音频元素上。重复调用只会重绑一次事件，供 ensureAudio 复用。
 */
export function attachProgressDriver(element: HTMLAudioElement): void {
  audio = element;
  sample();
  if (boundElement === element) return;
  boundElement = element;

  const refreshAndEmit = () => {
    sample();
    emit();
  };

  element.addEventListener('timeupdate', () => {
    sample();
    // 播放中由 rAF 负责推送，这里只在暂停态补一次（例如拖拽进度后暂停）
    if (element.paused) emit();
  });
  element.addEventListener('seeking', refreshAndEmit);
  element.addEventListener('seeked', sample);
  element.addEventListener('loadedmetadata', refreshAndEmit);
  element.addEventListener('durationchange', () => emit());
  element.addEventListener('emptied', refreshAndEmit);
  element.addEventListener('ratechange', sample);

  element.addEventListener('play', () => {
    sample();
    document.documentElement.dataset.playing = 'true';
    start();
  });
  element.addEventListener('playing', () => {
    sample();
    document.documentElement.dataset.playing = 'true';
    start();
  });
  element.addEventListener('pause', () => {
    document.documentElement.dataset.playing = 'false';
    stop();
  });
  element.addEventListener('ended', () => {
    document.documentElement.dataset.playing = 'false';
    stop();
  });

  document.documentElement.dataset.playing = element.paused ? 'false' : 'true';
  // 绑定后立刻播一次：此时可能已经有控件订阅过了（它们订阅时还没有音频元素）
  emit();

  // 窗口不可见时不必逐帧推进；切回来时锚点会重新对齐
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (audio && !audio.paused) start();
  });
}
