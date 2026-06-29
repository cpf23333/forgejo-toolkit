import { defineConfig } from 'vite';
import path from 'path';
import { vscodeElementsVue } from '@forgejo/vscode-elements-vue';

export default defineConfig({
  plugins: [
    vscodeElementsVue(),
  ],
  root: path.resolve(__dirname),
  base: './',
  build: {
    outDir: path.resolve(__dirname, '..', 'out', 'webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
