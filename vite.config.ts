import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // jassub 的 worker 入口含裸模块导入（abslink / lfa-ponyfill），必须交给 Vite 打成单 chunk；
  // 同时排除预打包，避免 new URL(..., import.meta.url) 指向 .vite/deps 下不存在的文件。
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['jassub'] },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    // libass 的 wasm 体积较大，不作为内联资源，保持独立文件便于排查
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
