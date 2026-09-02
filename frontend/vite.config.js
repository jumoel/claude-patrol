import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.js',
    alias: [
      {
        find: /^@xterm\/xterm$/,
        replacement: new URL('../vendor/xterm.js/lib/xterm.mjs', import.meta.url).pathname,
      },
      {
        find: /^@xterm\/addon-fit$/,
        replacement: new URL('../vendor/xterm.js/addons/addon-fit/lib/addon-fit.mjs', import.meta.url).pathname,
      },
      {
        find: /^@xterm\/addon-unicode-graphemes$/,
        replacement: new URL(
          '../vendor/xterm.js/addons/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs',
          import.meta.url,
        ).pathname,
      },
      {
        find: /^@xterm\/addon-webgl$/,
        replacement: new URL('../vendor/xterm.js/addons/addon-webgl/lib/addon-webgl.mjs', import.meta.url).pathname,
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
