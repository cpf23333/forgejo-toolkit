import { defineConfig } from 'vite';
import path from 'path';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag.startsWith('vscode-'),
        },
      },
    }),
  ],
  root: path.resolve(__dirname),
  base: './',
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  css: {
    transformer: 'lightningcss',
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'out', 'webview'),
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
});
