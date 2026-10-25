import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// --mode demo: the static demo (web/src/demo/), relative paths so it can sit under any folder.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: mode === 'demo' ? './' : '/',
  plugins: [preact()],
  define: { __LUMEN_VERSION__: JSON.stringify(version) },     // 设置 → 关于
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8780', '/img': 'http://127.0.0.1:8780', '/icon': 'http://127.0.0.1:8780' },
  },
}));
