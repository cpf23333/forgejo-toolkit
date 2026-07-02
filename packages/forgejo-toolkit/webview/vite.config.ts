import { defineConfig } from 'vite';
import path from 'path';
import vscodeElementsVue from '@cpf23333-forgejo-toolkit/vscode-elements-vue/vite-plugin';

export default defineConfig({
  plugins: [vscodeElementsVue()],
  root: path.resolve(__dirname),
  base: './',
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'out', 'webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
});
