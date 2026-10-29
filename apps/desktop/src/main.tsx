import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyMotionTier, watchFrameBudget } from './shared/lib/motion-mode';
import { installProbe } from './shared/lib/perf-probe';
import './shared/styles/tokens.css';
import './shared/styles/base.css';
import './shared/styles/layout.css';
import './shared/styles/components.css';
import './shared/styles/pages.css';
import './shared/styles/motion.css';
import './shared/styles/boot.css';

// 动效档位必须在首屏渲染前落定，否则入场动画会先按 full 档跑起来
applyMotionTier();
// 合成能力探测放在启动之后，不阻塞首屏
watchFrameBudget();
installProbe();

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
