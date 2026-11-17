import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const mount = document.getElementById('root');
if (!mount) {
  throw new Error('找不到页面挂载点');
}

// 不用 StrictMode：预览会话、事件订阅、播放器实例都是一次性副作用，
// 开发环境双调用会重复起预览服务与重复订阅。
createRoot(mount).render(<App />);
