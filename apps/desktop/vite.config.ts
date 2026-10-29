import { fileURLToPath, URL } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error 平台层是纯 ESM JavaScript，无类型声明文件
import { platformPlugin } from './server/plugin.mjs';

const src = fileURLToPath(new URL('./src', import.meta.url));
const core = fileURLToPath(new URL('../../packages/core/src', import.meta.url));
const types = fileURLToPath(new URL('../../packages/shared-types/src', import.meta.url));

export default defineConfig({
  plugins: [react(), platformPlugin()],
  resolve: {
    alias: [
      { find: '@core/', replacement: `${core}/` },
      { find: '@core', replacement: `${core}/index.ts` },
      { find: '@shared-types', replacement: `${types}/index.ts` },
      { find: '@', replacement: `${src}/` },
    ],
  },
  server: {
    port: 5273,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
    // Tauri 编译时会锁定 target 下的 exe，Vite 不能去 watch 这些文件
    watch: { ignored: ['**/src-tauri/**', '**/.data/**'] },
  },
  preview: { port: 5274, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
