import { defineConfig } from 'vitest/config';

// 测试独立配置：Vite 构建仍使用 vite.config.ts（root 指向 src/renderer），互不干扰。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
