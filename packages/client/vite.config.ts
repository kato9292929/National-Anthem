import { defineConfig } from 'vite';

/** 同一オリジン配信（NA_SERVE_CLIENT=1）でも動くように相対パスで吐く。 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env['NA_SERVER_PORT'] ?? '8787'}`,
        changeOrigin: true,
      },
      '/assets': {
        target: `http://localhost:${process.env['NA_SERVER_PORT'] ?? '8787'}`,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
