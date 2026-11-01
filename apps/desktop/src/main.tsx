import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LyricWindow } from './features/player/LyricWindow';
import { TaskbarPanel } from './features/taskbar/TaskbarPanel';
import { applyMotionTier, watchFrameBudget } from './shared/lib/motion-mode';
import { installProbe } from './shared/lib/perf-probe';
import './shared/styles/tokens.css';
import './shared/styles/base.css';
import './shared/styles/layout.css';
import './shared/styles/components.css';
import './shared/styles/pages.css';
import './shared/styles/motion.css';
import './shared/styles/boot.css';
import './shared/styles/lyric.css';
import './shared/styles/taskbar.css';

// 同一个入口产出三种窗口：主界面走路由，桌面歌词与任务栏面板各挂一层轻量组件。
// 判定放在渲染之前，顺带把 <html> 标好，透明底样式才能第一帧就生效。
const overlay = new URLSearchParams(window.location.search).get('window');
const isLyricWindow = overlay === 'lyric';
const isTaskbarWindow = overlay === 'taskbar';
const isOverlay = isLyricWindow || isTaskbarWindow;
if (isOverlay) document.documentElement.dataset.window = overlay as string;

// 动效档位必须在首屏渲染前落定，否则入场动画会先按 full 档跑起来
applyMotionTier();
// 合成能力探测放在启动之后，不阻塞首屏；两个浮窗都没有装饰动效，不必探测
if (!isOverlay) {
  watchFrameBudget();
  installProbe();
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    {isLyricWindow ? <LyricWindow /> : isTaskbarWindow ? <TaskbarPanel /> : <App />}
  </StrictMode>,
);
