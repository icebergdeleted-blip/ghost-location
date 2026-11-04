import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1', strictPort: true, port: 5173,
    // Electron's dev userData (.ghost-dev) holds files Windows keeps locked (EBUSY);
    // runtimes and artifacts are not renderer sources either.
    watch: { ignored: ['**/.ghost-dev/**', '**/artifacts/**', '**/resources/**', '**/sidecar/**', '**/release/**'] },
  },
  build: { outDir: 'dist', target: 'chrome140', sourcemap: true }
});
