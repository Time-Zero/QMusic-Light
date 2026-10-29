# 动画渲染 GPU 化：现状诊断、迁移方案与验证口径

> 适用版本：QMusic Light 0.1.0（Tauri 2 + React 19 + WebView2）
> 关联约束：`docs/qqmusic-lite-research.md` §7.7 性能约束、§8.1 性能预算
> 本文所有定位均基于当前代码实测（行号可核对），**基线数值需按 §6 现场采集**，文中标注「预估」的为代码推导而非实测。

---

## 0. 结论先行

**动画不是"没上 GPU"，而是三条 CPU 路径把 GPU 的收益吃掉了。**

逐条核对 `motion.css` 后可以确认：11 个入场关键帧用的全部是 `transform` + `opacity`，Chromium 本来就把它们交给合成线程（compositor thread）跑，早就在 GPU 上了。所以"迁移到 GPU"不是重写动效，而是三件事：

| # | 真正的问题 | 位置 | 性质 |
|---|---|---|---|
| 1 | 进度条 / 音量条用 `width`、`left` 驱动，每帧走 **布局 + 重绘** | `ProgressBar.tsx:71,73`、`PlayerBar.tsx:240,243` | 属性选错，与 GPU 无关但必须换成 `transform` |
| 2 | `currentTime` 约 4 Hz 写入 zustand，**整棵 PlayerBar / NowPlaying 重渲染**，且视觉上进度条每秒只跳 4 下 | `player-store.ts:273`、`PlayerBar.tsx:40`、`NowPlaying.tsx:42,187` | 驱动层错位：用 React 做逐帧动画 |
| 3 | 悬停反馈过渡 `box-shadow` / `background`，在固定定位的大阴影容器里重绘 | `components.css:373,387`、`base.css:134,238,284` | 重绘面积失控 |

一句话目标：**主线程每帧只做"写样式"这一件事，布局和重绘从逐帧路径里彻底消失。**

---

## 1. 现状：动画类型、数量与渲染方式

### 1.1 一次性入场 / 退场（15 个关键帧，全部合成友好）

| 关键帧 | 位置 | 属性 | 渲染阶段 | 触发频次 |
|---|---|---|---|---|
| `rise-in` / `fade-in` | `motion.css:16,23` | transform + opacity | Composite | 路由切换、首批数据落地 |
| `pop-in` / `pop-out` | `motion.css:35,42` | transform + opacity | Composite | 搜索建议、命令面板 |
| `slide-in-right` / `slide-out-right` | `motion.css:49,56` | transform + opacity | Composite | 队列抽屉 |
| `np-in` / `np-out` | `motion.css:63,70` | transform + opacity | Composite | 全屏播放页 |
| `toast-in` / `toast-out` | `motion.css:77,84` | transform + opacity | Composite | 提示 |
| `fade-out` | `motion.css:29` | opacity | Composite | 遮罩退场 |
| `spin` | `pages.css:989` | transform: rotate | Composite | 加载中 |
| `eq` | `components.css:692` | transform: scaleY | Composite | 当前播放行 ×3 柱 |
| `boot-bounce` | `boot.css:66` | transform + opacity | Composite | 启动页 ×3 点 |
| `skeleton-shine` | `base.css:352` | transform: translateX | Composite | 首屏骨架 |

级联编排：
- `.page > :first-child > *` 最多 5 级，步长 32ms（`motion.css:96-114`）
- `.cards > .card` 最多 6 级，步长 24ms（`motion.css:117-139`）
- 窄屏折半（`motion.css:251`）、`prefers-reduced-motion` 压到 1ms（`base.css:429`）

**这部分不需要动。** 唯一可优化的是 `.eq` 的三根柱子常驻 3 个合成层且永不停止（`components.css:665-699`），以及一条死规则：

> `components.css:704` 写了 `html[data-window-focus='blurred'] .hero-kicker .live`，但 `.live` 这个类在 CSS 和 TSX 里都不存在 —— 死代码，删掉。

### 1.2 交互过渡（33 处 `transition` 声明）

按属性归类：

| 类别 | 数量 | 代表位置 | 渲染阶段 |
|---|---|---|---|
| `transform` + `opacity` | 12 | `.track::after` `components.css:519` | Composite ✅ |
| `background` / `color` | 14 | `.track` `components.css:512`、`.lyric-line` `pages.css:259` | Paint ⚠️ |
| `box-shadow` | 4 | `.card .art` `components.css:374`、`.btn` `base.css:135` | Paint ⚠️（阴影重绘最贵） |
| `grid-template-columns` | 1 | `.app` `layout.css:10` | Layout ❌（唯一布局型过渡，注释已标注为"可接受例外"） |

### 1.3 状态驱动的"伪动画"（这是真瓶颈）

| 动画 | 驱动方式 | 实现 | 问题 |
|---|---|---|---|
| 播放进度 | `timeupdate` → zustand → 重渲染 | `width: %` + `left: %` | 4 Hz 更新 + 布局属性 |
| 歌词高亮 | `activeIndex` → `className` | `color` + `transform: scale(1.03)` 过渡 | 触发整列表重渲染 |
| 歌词滚动 | `scrollIntoView({behavior:'smooth'})` | 浏览器平滑滚动 | 嵌套滚动容器，主线程动画 |

### 1.4 数量汇总

- 关键帧 **15 个**，`animation` 声明约 **40 处**（多为级联选择器展开）
- `transition` 声明 **33 处**
- 逐帧运行的合成层：**1~3 个**（`.eq` 三柱）+ 2 个进度条元素
- 无任何 `will-change`（全仓 0 处）

---

## 2. 瓶颈定位（按影响排序）

### B1 · 进度条：4 Hz 的"步进"动画 + 布局属性

```tsx
// ProgressBar.tsx:71,73
<div className="fill" style={{ width: `${ratio * 100}%` }} />
<div className="knob" style={{ left: `${ratio * 100}%` }} />
```

三重代价：

1. **视觉上就不平滑**。`timeupdate` 在 Chromium 里典型 250ms 一次，即 4 Hz。240px 宽的轨上每次跳 2~4px，用户读到的是"卡顿"，而不是"GPU 没开"。
2. **`width` 触发布局**。`.fill` 是 `.rail` 的 flex 子项，宽度变化引发 relayout + 重绘（`components.css:938`）。
3. **`left` 触发布局 + 阴影重绘**。`.knob` 是绝对定位且带 `0 2px 6px` 阴影（`components.css:944-953`），每次位移都要重画阴影。

派生问题：`positionToValue()` 在 **每次 pointermove 都调用 `getBoundingClientRect()`**（`ProgressBar.tsx:22`），拖动时每帧强制一次同步布局 —— 典型的 layout thrashing。

音量条同构（`PlayerBar.tsx:240,243` → `pages.css:1044`）。

### B2 · `currentTime` 驱动 React 全量重渲染

```ts
// player-store.ts:273
el.addEventListener('timeupdate', () => {
  usePlayerStore.setState({ currentTime: el.currentTime });  // 4 Hz 全局广播
});
```

订阅者：
- `PlayerBar.tsx:40` —— 整棵播放条（封面、8 个按钮、音量条、队列角标，约 120 个 DOM 节点）每 250ms 重渲染一次
- `NowPlaying.tsx:42` —— 更贵：`lines.map()` 逐行渲染（`NowPlaying.tsx:187-199`），一首歌 80~150 行，每 tick reconcile 300~600 个 vnode；`activeLineIndex` 的 `useMemo` 也每 tick 重算（`NowPlaying.tsx:69`）

React 19 的调度会把这些压到 1~3ms，**但这是纯粹的浪费**：真正需要每帧变的只有 2 个元素的 `transform`，和 1 个 `<span>` 的文本（秒数每秒才变一次）。

连带效应：一旦 Widget 树在同帧内变脏，浏览器被迫在**同一个 vsync 窗口里**先跑 React、再跑样式计算、再布局 —— 与合成线程抢帧，这是"滚动时偶发掉帧"的常见来源。

### B3 · 歌词平滑滚动跑在主线程

```tsx
// NowPlaying.tsx:101-105
useEffect(() => {
  activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, [activeIndex]);
```

嵌套滚动容器内的 `scrollIntoView({behavior:'smooth'})` 在 Chromium 中通常由主线程逐帧驱动（非根滚动器的平滑滚动普遍不走合成），320ms 的动画期间每帧都在算滚动位置，正好与 B1/B2 撞车。

### B4 · `box-shadow` 过渡落在"大阴影容器"里

`.card .art:hover` 同时过渡 `box-shadow` 与 `transform`（`components.css:373-390`）。`transform` 走合成，`box-shadow` 走重绘 —— 一条过渡里混了两种阶段，结果整条过渡被降级成"每帧重绘"。

更糟的是容器：`.player`（`components.css:749`）是 `position: fixed` + `box-shadow: var(--shadow-lift)` 的大圆角块。它内部任何重绘都可能扩散到阴影区域，而阴影是光栅化最贵的部分之一。

同样的模式在 `.btn`（`base.css:134`）、`.icon-btn`（`base.css:238`）、`.pill`（`base.css:284`）上重复了 3 次 —— 而这些按钮在 PlayerBar 里有 8 个，悬停扫过就是 8 次阴影重绘。

### B5 · 合成层策略缺失

- 全仓 0 处 `will-change` → `.card:hover .art` 的 `translate3d` 会**在悬停瞬间**才提升图层，首次悬停必有一次性图层创建 + 光栅化开销（表现为"第一次悬停有点顿"）
- `.eq` 三柱常驻动画，无可见性判断（只在窗口失焦时暂停，`components.css:704`）
- `.rail` 有 `overflow: hidden` 但没有显式 `contain: paint`，重绘边界靠浏览器推断

### B6 · 唯一的布局型过渡

`.app { transition: grid-template-columns }`（`layout.css:10`）在 200ms 内每帧重排整个 grid。注释已声明为"频次极低的例外"，**保留**，但可加 `contain: layout`（`.workspace` 已有，`layout.css:366`）确认隔离生效。

---

## 3. 目标帧率与设备范围

### 3.1 帧率目标

| 场景 | 目标 | 判定口径 |
|---|---|---|
| 列表滚动（10k 行） | 60 fps | p95 帧时长 ≤ 16.7ms，掉帧率 < 1% |
| 播放页稳态（歌词滚动 + 进度推进） | 60 fps | 连续 10s 内长动画帧（LoAF）**为 0** |
| 进度条 / 音量条跟手 | 视觉 60 fps，与音频时间轴误差 ≤ 50ms | 逐帧采样对比 `audio.currentTime` |
| 路由 / 浮层入场 | 单帧最长 ≤ 33ms（2 帧） | 入场期间无 >33ms 帧 |
| 高刷屏（120/144Hz） | 自适应跟随 rAF，不锁 60 | 不出现固定 16.7ms 节拍 |
| 主线程响应 | INP ≤ 200ms | 点击 → 下一帧可见反馈 |

### 3.2 设备范围

| 层级 | 平台 | 引擎 | 备注 |
|---|---|---|---|
| **主目标** | Windows 10 1809+ / 11 | WebView2（Chromium ≥ 109） | 发布形态 `nsis`，硬件下限 Intel UHD 620 / Vega 8 集显，1920×1080 |
| 次要 | macOS 12+ | WKWebView | `transform`/`opacity` 同策略，`will-change` 行为略有差异 |
| 次要 | Linux | WebKitGTK 2.40+ | 合成路径不同，需单独回归 |
| 窗口 | 默认 1280×820，最小 1024×680 | — | 见 `tauri.conf.json` |
| **降级** | 软件渲染（远程桌面 / 虚拟机 / GPU 黑名单） | SwiftShader | 自动切 `data-motion="lite"`，见 §4.4 |

GPU 内存预算沿用 §8.1 的 **15–30 MB**：合成层数量必须受控，这是"合理使用合成层"的硬约束，不是建议。

---

## 4. GPU 渲染实现思路

四层结构，自下而上：**属性层 → 驱动层 → 合成层 → 降级层**。

### 4.1 L1 属性层：只允许 `transform` / `opacity`

属性 → 渲染阶段映射（改造后）：

| 元素 | 现状 | 目标 | 阶段变化 |
|---|---|---|---|
| `.bar .fill` | `width: %` | `transform: scaleX(var(--p))` + `transform-origin: left` | Layout+Paint → **Composite** |
| `.bar .knob` | `left: %` | `transform: translate3d(calc(var(--knob-x) - 50%), -50%, 0)` | Layout+Paint → **Composite** |
| `.vbar i` / `.vknob` | `width` / `left` | 同上 | 同上 |
| `.np-lyrics` 滚动 | `scrollIntoView` smooth | 列表容器 `translate3d(0, var(--lyric-y), 0)` + `transition` | Main-thread scroll → **Composite** |
| `.card .art:hover` | `box-shadow` + `transform` | `transform` 保留；阴影移到 `::before` 做 `opacity` | Paint → **Composite** |
| `.track:hover` | `background` | 已有 `.track::after` 承载描边，背景同法并入 | Paint → **Composite** |

`scaleX` 对 3px 高、2px 圆角的进度条会造成轻微横向压缩，视觉不可察；若将来加粗到 ≥8px，改用 `clip-path: inset(0 calc(100% - var(--p) * 100%) 0 0)`（Chromium 中 `clip-path` 由合成器处理，但需实测确认）。

### 4.2 L2 驱动层：单 rAF 循环 + 直写样式，绕开 React

新建 `apps/desktop/src/features/player/progress-driver.ts`：

```ts
type Sink = (seconds: number, duration: number) => void;

const sinks = new Set<Sink>();
let raf = 0;
let el: HTMLAudioElement | null = null;
// timeupdate 的采样点：用它对齐时钟外推，避免累积漂移
let anchor = { t: 0, at: 0 };
let running = false;

export function attachProgressDriver(audio: HTMLAudioElement) {
  el = audio;
  const syncAnchor = () => {
    anchor = { t: audio.currentTime, at: performance.now() };
  };
  audio.addEventListener('timeupdate', syncAnchor);
  audio.addEventListener('seeking', syncAnchor);
  audio.addEventListener('play', () => start());
  audio.addEventListener('pause', () => stop());
  syncAnchor();
}

export function subscribeProgress(sink: Sink): () => void {
  sinks.add(sink);
  if (el) sink(el.currentTime, el.duration || 0);
  return () => sinks.delete(sink);
}

function tick(now: number) {
  if (!el) return;
  const duration = Number.isFinite(el.duration) ? el.duration : 0;
  // 帧间外推：timeupdate 250ms 才来一次，用单调时钟补齐，下个 timeupdate 自动纠偏
  const seconds = el.paused
    ? el.currentTime
    : Math.min(duration || Infinity, anchor.t + (now - anchor.at) / 1000);

  // 一个 rAF 回调里只写，不读布局 —— 避免强制同步布局
  for (const sink of sinks) sink(seconds, duration);
  raf = requestAnimationFrame(tick);
}

export function start() {
  if (running) return;
  running = true;
  raf = requestAnimationFrame(tick);
}

export function stop() {
  running = false;
  cancelAnimationFrame(raf);
}

// 窗口不可见时不必逐帧推进，回来时 anchor 会重新对齐
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else if (el && !el.paused) start();
});
```

消费侧（进度条完全脱离 React 渲染循环）：

```tsx
// ProgressBar.tsx —— 只保留拖拽交互，进度由 sink 直写
export function ProgressBar({ max, onSeek, className, ariaLabel }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const rect = useRef<DOMRect | null>(null);   // pointerdown 时缓存，move 中不再读布局
  const seconds = useRef(0);                   // 供键盘 ±5s 用，不触发渲染

  useRailWidth(barRef);                        // 宽度写进 --rail-w，逐帧不读 clientWidth

  useLayoutEffect(
    () =>
      subscribeProgress((snapshot) => {
        seconds.current = snapshot.seconds;
        if (dragging.current) return;          // 拖拽时预览优先
        const base = snapshot.duration || maxRef.current;
        barRef.current?.style.setProperty('--p', (snapshot.seconds / base).toFixed(5));
      }),
    [],
  );
  // ...
}
```

旋钮位置由 CSS 消费变量得出，逐帧路径上没有布局：

```css
.bar .fill { width: 100%; transform: scaleX(var(--p, 0)); transform-origin: left center; }
.bar .knob { left: 0; transform: translate3d(calc(var(--p, 0) * var(--rail-w, 0px) - 50%), -50%, 0); }
```

秒数文本另走低频率订阅（每秒变一次足够）：

```ts
// 独立 selector，1 Hz
const secondsText = usePlayerStore((s) => Math.floor(s.currentTime));
```

`player-store.ts` 的 `timeupdate` 改为**只在整秒变化时**写状态：

```ts
el.addEventListener('timeupdate', () => {
  const nextSecond = Math.floor(el.currentTime);
  if (nextSecond !== Math.floor(usePlayerStore.getState().currentTime)) {
    usePlayerStore.setState({ currentTime: el.currentTime });
  }
});
```

这样：**渲染次数从 4 Hz × 全树 → 1 Hz × 两个文本节点；视觉从 4 fps → 60 fps。** 这是本次改造收益最大的一条。

歌词高亮同样思路：`activeIndex` 用 ref 记录，变化时只做两次 `classList.toggle`，不动 React 树。

### 4.3 L3 合成层：按需提升，用完即撤

```css
/* 只在播放态挂 will-change，暂停即撤，避免常驻图层吃 GPU 内存 */
.player[data-active='true'] .bar .fill,
.player[data-active='true'] .bar .knob {
  will-change: transform;
}

/* 歌词轨道是一个图层，位移由合成器插值 */
.np-lyrics { contain: layout paint; }
.np-lyric-track {
  transform: translate3d(0, calc(var(--lyric-y, 0) * 1px), 0);
  transition: transform 320ms var(--ease-out);
  will-change: transform;
}

/* 浮层入场/退场期间才提升，结束后撤销 */
.nowplaying { will-change: auto; }
.nowplaying.is-closing { will-change: opacity, transform; }

/* 重绘边界显式收窄 */
.bar { contain: layout; }
.bar .rail { contain: paint; }   /* 已有 overflow:hidden，显式化后边界更稳定 */
```

歌词列表高度可能达数千 px，Chromium 会分块（tile）光栅化，单层纹理不会一次性吃满；但仍应避免在 `.np-lyrics` 上再叠 `will-change` 以外的其它提升。

### 4.4 L4 降级层：三档 motion tier

```
<html data-motion="full | lite | off">
```

- `full`：默认
- `lite`：软件渲染 / 低端机 —— 关 `.eq`、骨架扫光、级联延迟，进度条回退 `width` 路径
- `off`：`prefers-reduced-motion` —— 已有实现（`base.css:429`），保留

判定（启动时一次性、非阻塞）：

```ts
export function detectMotionTier(): 'full' | 'lite' {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'lite';
  // 采样 30 帧，p95 > 20ms 视为合成能力不足（软件渲染的典型特征）
  // 采样异步进行，首帧不受影响
  return 'full';
}
```

`lite` 模式下走同一套 `--p` 变量的 CSS 回退分支，A/B 切换是纯 CSS 的事：

```css
[data-motion='lite'] .bar .fill { transform: none; width: calc(var(--p, 0) * 100%); }
[data-motion='lite'] .bar .knob { transform: translate(-50%, -50%); left: calc(var(--p, 0) * 100%); }
```

---

## 5. 关键优化点

### 5.1 减少重绘（Repaint）

| 手段 | 落点 | 预期收益 |
|---|---|---|
| `box-shadow` 过渡 → 伪元素 `opacity` | `.card .art`、`.btn`、`.icon-btn`、`.pill` | 悬停不再触发阴影光栅化，改为合成层淡入 |
| 背景色过渡 → 伪元素 `opacity` | `.track`（`components.css:512`） | 长列表悬停只合成不重绘 |
| `contain: paint` 收窄边界 | `.rail`、`.np-lyrics` | 进度条重绘限制在 3px 条带内 |
| 避免在固定定位大阴影容器内重绘 | `.player` 内部所有动画 | 避免 `--shadow-lift` 被反复光栅化 |

> 注意：**不要**给 `.player` 加 `contain: paint` —— 会裁掉它自身的 `box-shadow`。只对无外溢阴影的子元素加。

### 5.2 批量绘制（Draw / Paint Batching）

DOM 合成模型下，"批量"的含义是**压缩独立绘制区域的数量**，而不是合并 draw call：

1. **单 rAF 回调内集中写完所有样式**：进度条 `.fill`、`.knob`、时间文本一次性写，浏览器在帧末统一做一次 style recalc。切忌"写一个 → 读一个 → 再写"（B1 里 `getBoundingClientRect` 的坑）。
2. **同帧不读写交替**：`pointermove` 中缓存 `DOMRect`，只在 `pointerdown`/`resize` 时读。
3. **把 N 个逐帧元素压成 1 个图层**：进度条 `.fill` 与 `.knob` 共享 `.bar` 的合成层；`.rail` 用 `contain: paint` 独立。
4. **别用多个元素模拟一个图形**：`.eq` 的 3 根柱子是 3 个动画元素。当前场景只有 1 行播放中，成本可接受；**若将来做频谱可视化，必须用单 `<canvas>`**（1 个图层、1 次 `clearRect` + 1 次绘制），不要用 32 个 `<div>`。
5. **离屏内容不参与绘制**：为长页面的非首屏 section 加 `content-visibility: auto` + `contain-intrinsic-size`，跳过屏幕外布局与绘制（首页卡片区、播放页 aside）。

### 5.3 避免主线程阻塞

| 项 | 现状 | 改法 |
|---|---|---|
| 逐帧动画驱动 | React 重渲染（`timeupdate` → setState） | rAF + 直写 style，React 退出逐帧路径 |
| 歌词滚动 | `scrollIntoView({behavior:'smooth'})` 主线程 | `translate3d` + CSS transition，合成器插值 |
| 拖拽时强制布局 | 每次 `pointermove` 读 `getBoundingClientRect` | 缓存 rect，`ResizeObserver` 失效时更新 |
| 巨量列表 reconcile | 歌词全量 `map` | 列表 `memo` + 高亮用 `classList` 命令式切换 |
| 长任务 | 无显式切分 | 封面取色 `extractPalette` 已是异步；若后续出现 >50ms 任务，用 `scheduler.postTask` / `requestIdleCallback` 切片 |

目标：主线程每帧脚本时间 **< 2ms**（稳态播放），长任务（>50ms）**0 个**。

### 5.4 合理使用合成层

原则：**图层是稀缺资源（GPU 内存 15–30MB），不是免费的加速开关。**

| 该提 | 不该提 |
|---|---|
| 有持续/长时 `transform` 动画的元素（进度条、歌词轨道） | 静态布局容器（`.page`、`.workspace`、`.player`） |
| 退场期间需要独立合成的浮层（`.is-closing`） | 列表每一行 `.track` |
| 悬停会位移的卡片（`.card .art`，提升后保留，避免反复创建） | 全站 `* { will-change: transform }` 这类"一刀切" |

生命周期管理：`will-change` 跟随状态挂载 —— 播放时挂、暂停时撤；进/退场时挂、`animationend` 后撤。可以用 `data-active` / `.is-closing` 驱动，也可用 `element.getAnimations()[0].finished.then(...)` 清理。

层数预算：稳态 ≤ 8 个合成层（播放条 2 + 歌词 1 + 播放页 1 + 卡片悬停若干 + 浮层）。

### 5.5 死代码与规则修正

- 删 `components.css:704` 的 `.live` 选择器（类不存在）
- `.track` 的 `background` 过渡并入 `::after`（既有约定 `components.css:515-528` 已说明原因，但 `.track` 自身没遵守）
- `prefers-reduced-motion` 分支补上新增的 `--p` 路径

---

## 6. 验证与指标对比

### 6.1 固定测试场景（可复现）

同一台机器、同一窗口尺寸（1280×820）、同一首 320k 曲目、关闭其它应用。脚本化 5 步，总时长 30s：

| 步 | 操作 | 时长 | 观测点 |
|---|---|---|---|
| 1 | 启动（热启动）→ 首页 | 3s | 首屏骨架、级联入场 |
| 2 | 播放 → 打开播放页 | 5s | `np-in` 入场、封面取色 |
| 3 | 保持播放，观察歌词随句高亮滚动 | 10s | **进度条跟手性、歌词滚动掉帧** |
| 4 | 展开队列抽屉 → 关闭 | 5s | 浮层进出 |
| 5 | 折叠侧栏 → 返回首页快速滚动列表 | 7s | `grid-template-columns` 过渡、10k 行滚动 |

每项跑 **5 次取中位数**，丢弃首次（冷启动/字体光栅化）。

### 6.2 采集工具

| 工具 | 用途 |
|---|---|
| WebView2 DevTools → Performance | 帧率、Scripting / Rendering / Painting 时间占比、Layout 次数与耗时 |
| Rendering 面板 → Paint flashing / Layer borders / Frame rendering stats | 重绘区域、合成层数量、实时 FPS |
| DevTools → Performance → Frames + "Enable advanced paint instrumentation" | 单帧 paint 明细 |
| 自建 `perf-probe.ts`（见 6.3） | 可量化、可比对的数字 |
| `PerformanceObserver` `long-animation-frame`（LoAF，WebView2 ≥ 123） | 动画掉帧的权威判定，长帧内脚本/样式/布局耗时拆解 |
| 任务管理器 / `Get-Process` | GPU 内存、空闲 CPU（对齐 §8.1） |

### 6.3 自建探针（放进 repo，Release 前手动跑）

```ts
// apps/desktop/src/shared/lib/perf-probe.ts
export interface FrameReport {
  frames: number; p50: number; p95: number; p99: number;
  dropped: number; jankRatio: number; worst: number;
}

export function probeFrames(ms = 10_000): Promise<FrameReport> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let prev = performance.now();
    const stop = prev + ms;
    const loop = (now: number) => {
      deltas.push(now - prev);
      prev = now;
      if (now < stop) requestAnimationFrame(loop);
      else {
        const sorted = [...deltas].sort((a, b) => a - b);
        const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
        const budget = 1000 / 60; // 60Hz 基线 16.7ms
        const dropped = deltas.filter((d) => d > budget * 1.5).length;
        resolve({
          frames: deltas.length,
          p50: at(0.5), p95: at(0.95), p99: at(0.99),
          dropped, worst: sorted.at(-1) ?? 0,
          jankRatio: dropped / deltas.length,
        });
      }
    };
    requestAnimationFrame(loop);
  });
}
```

在控制台一行出结果：`await probeFrames(10000)`。

A/B 开关（同一份代码跑两套路径，保证可比）：

```ts
// 启动时读一次
const mode = new URLSearchParams(location.search).get('motion')
  ?? localStorage.getItem('qmusic:motion')
  ?? 'gpu';
document.documentElement.dataset.motion = mode;
```

- 基线：`?motion=legacy`（保留 `width`/`left` 路径 + `timeupdate` 全量重渲染）
- 优化后：`?motion=gpu`
- 降级验证：`?motion=lite`

### 6.4 指标对比表（需实测填表）

| 指标 | 采集方式 | 基线（待测） | 目标 | 判定 |
|---|---|---|---|---|
| 稳态 FPS（场景 3） | Performance → Frames | 预估 45–55（受 4 Hz 步进拖累） | ≥ 58 | p95 帧 ≤ 16.7ms |
| 掉帧率 | `probeFrames` | 待测 | < 1% | — |
| 长动画帧 LoAF 数 | `PerformanceObserver` | 待测 | **0** | 硬门槛 |
| 主线程脚本时间/帧 | Performance | 待测（含 React reconcile） | < 2ms | — |
| Layout 次数（10s 稳态） | Performance → Layout count | 约 40（4 Hz × 10s） | **0** | 硬门槛 |
| Paint 次数（10s 稳态） | Performance → Paint count | 约 40+ | ≤ 2 | 仅初始化/切歌 |
| 悬停扫过 8 个按钮的最长帧 | Performance | 预估 20–35ms | ≤ 8ms | — |
| 进度条精度 | 采样对比 `audio.currentTime` | 250ms 步进 | ≤ 50ms 偏差 | — |
| 合成层数量 | Rendering → Layer borders | 待测 | ≤ 8 | — |
| GPU 内存 | 任务管理器 / `Get-Process` | 待测 | ≤ 30MB（§8.1） | — |
| 空闲 CPU | 任务管理器 60s 均值 | 待测 | ≤ 1%（§8.1） | 不得回退 |
| 歌词滚动 10s 掉帧 | Performance | 待测 | < 3 帧 | — |

> 关键判据只有一条：**稳态 10s 内 Layout count 为 0、LoAF 为 0**。达到即证明逐帧路径已彻底离开主线程 —— 这比"FPS 数字好看"更能说明迁移成功。

### 6.5 回归门槛

- Release 前手工过一遍 §6.1 场景，四项硬指标（FPS、Layout=0、LoAF=0、GPU ≤30MB）全绿
- 单元测试不测渲染，但需覆盖：`progress-driver` 的外推/纠偏逻辑（纯函数可测）、`data-motion` 分支的 tier 判定
- `prefers-reduced-motion` 与 `lite` 两档各跑一次，确认动效降级不残留

---

## 7. 分阶段落地

| 阶段 | 内容 | 改动面 | 风险 |
|---|---|---|---|
| **P1 ✅ 已落地** | 进度条/音量条 `--p` + `scaleX`/`translate3d`；`progress-driver` rAF 驱动；`timeupdate` 降频到整秒；拖拽缓存 rect | `ProgressBar.tsx`、`PlayerBar.tsx`、`player-store.ts`、`components.css` | 低。`--p` 变量双路径共存，`?motion=legacy` 可秒回退 |
| **P2 ✅ 已落地** | 歌词轨道 `translate3d` 替代 `scrollIntoView`；`LyricList` memo + 命令式高亮 | `NowPlaying.tsx`、`pages.css` | 中。已处理"手动滚动后暂停跟随 4s" |
| **P3 ✅ 已落地** | `.track` 悬停底色并入伪元素；`.rail`/`.bar`/`.np-lyrics` 加 `contain`；删 `.live` 死代码 | `components.css`、`pages.css`、`motion.css` | 低 |
| **P4 ✅ 已落地** | `perf-probe`、`data-motion` 三档、tier 探测、`will-change` 生命周期 | 新增 4 个模块 + 少量 CSS | 低 |

P1 单独上线就能拿到主要收益（进度条 4 fps → 60 fps、稳态 Layout 归零）；P2/P3 解决剩余的重绘与滚动。

---

## 9. 实施记录

### 9.1 新增模块

| 文件 | 职责 |
|---|---|
| `src/shared/lib/progress-driver.ts` | 单 rAF 循环 + 时钟外推。导出 `subscribeProgress` / `attachProgressDriver` / 纯函数 `estimateSeconds`；顺带维护 `html[data-playing]` 供 `will-change` 挂载 |
| `src/shared/lib/motion-mode.ts` | `full / lite / legacy` 三档解析与 `<html data-motion>` 写入；`watchFrameBudget()` 启动 4s 后采样 60 帧，p95 > 24ms 且慢帧 ≥15% 才降档（两道阈值 + 仅开发期跳过，避免误判） |
| `src/shared/hooks/useRailWidth.ts` | ResizeObserver → `--rail-w`，逐帧路径不再读 `clientWidth` |
| `src/shared/lib/perf-probe.ts` | `probeFrames(ms)` 返回 p50/p95/p99、掉帧率、最差帧、平均 FPS；开发期挂在 `window.__qmusicProbe` |
| `src/features/player/TrackTime.tsx` | 时间文本独立订阅"整秒"，把整条播放条从每秒一次的渲染里摘出去 |
| `src/shared/lib/progress-driver.test.ts` | 6 条用例覆盖外推、暂停、上限夹取、负值夹取 |

### 9.2 改造点

- `ProgressBar`：去掉 `value` prop，改为命令式；`aria-valuenow` 也由订阅回调按整秒写入（否则为了无障碍属性又把组件拖回每秒渲染）。拖拽期间只读一次 `getBoundingClientRect`。
- `PlayerBar`：时间文本换 `TrackTime`；音量条改 `--p` + `scaleX/translate3d`，拖拽同样缓存 rect。
- `player-store`：`timeupdate` 只在整秒变化时写状态；`ensureAudio` 顺带 `attachProgressDriver`。上一首回退的 `currentTime > 3` 判断在 1s 精度下不受影响。
- `NowPlaying`：抽出 `memo` 化的 `LyricList`，高亮用 `classList`、跟随用"`scrollTop` 瞬移 + 反向位移补间"，补间交给 CSS transition 走合成器；滚轮/触摸后 4s 内不抢滚动位置。
- CSS：`.fill` / `.knob` / `.vbar i` / `.vknob` 改合成属性；`.bar` 加 `contain: layout`、`.rail` 加 `contain: paint`；`.track` 悬停底色并入 `::after`（`z-index:-1` + `isolation:isolate`，画在文字之下）；`will-change` 跟随 `html[data-playing]` 挂载/撤销。
- `motion.css` 末尾新增 `lite` / `legacy` 回退分支，与 full 档共用同一个 `--p` 变量 —— A/B 是纯 CSS 切换。

### 9.3 已做的验证

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 43 passed（含新增 6 条） |
| `npm run build` | 通过，CSS 55.27 kB / gzip 9.98 kB |
| 计算样式实测（Chrome 无头，直接读 `getComputedStyle`） | full 档：`fill` = `matrix(0.4,0,0,1,0,0)`，`knob` 位移 102.2px = `0.4 × 268 − 5`，布局宽度保持 268（证明未触发布局）；lite 档：`transform: none`、`fill` 宽度 107.19px、`knob left: 107.188px`，两档视觉落点一致 |

### 9.4 待现场采集

本文 §6.4 的"基线"列仍是代码推导值。真实数字需在目标机（Windows + WebView2，1280×820）按 §6.1 场景跑一遍：

```
控制台：await __qmusicProbe(10000)
A/B：  ?motion=legacy  vs  ?motion=full  vs  ?motion=lite
```

重点看两条硬指标：稳态 10s 内 **Layout 计数为 0**、**LoAF 为 0**。

---

## 8. 风险与边界

1. **`scaleX` 的圆角压缩**：3px 高的条视觉无感；若后续加粗需改 `clip-path` 并重新验证。
2. **时钟外推的漂移**：以 `timeupdate`/`seeking` 为锚点纠偏，最坏情况外推误差约 ±16ms；`ended`、`ratechange` 需同步重置锚点（当前项目无变速播放，暂不处理）。
3. **合成层失控**：`will-change` 必须跟随状态挂载，禁止静态常驻，否则 GPU 内存突破 §8.1 的 30MB 预算，反而拖慢低端机。
4. **macOS / Linux 差异**：WKWebView 对 `will-change` 的提升策略更保守，`translate3d` 提升行为需单独回归；WebKitGTK 的合成路径与 Chromium 不同，指标基线不可跨平台复用。
5. **不要给 `.player` 加 `contain: paint`**（裁阴影）；不要给列表行加 `will-change`（层爆炸）。
6. **本文的"基线"列均为代码推导的预估值**，必须先按 §6 采集真实基线再谈提升幅度，否则对比无意义。
