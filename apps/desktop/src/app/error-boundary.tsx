import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BootSplash } from '@/shared/ui/BootSplash';

interface State {
  error: Error | null;
}

/** 错误边界：接口漂移或渲染异常时不白屏（文档 §5.3） */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[QMusic] 渲染异常', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-wrap">
          <BootSplash error={`页面出现异常：${this.state.error.message}`} />
          <button className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
