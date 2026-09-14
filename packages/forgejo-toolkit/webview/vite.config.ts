import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import vue from '@vitejs/plugin-vue';

// vscode-elements' <vscode-icon> pulls the codicon stylesheet into its shadow
// DOM by reading the href of a <link id="vscode-codicon-stylesheet"> in the
// page (see content.ts). Ship that stylesheet with the webview bundle so the
// packaged extension does not need node_modules at runtime.
function copyCodicons(outDir: string) {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(dist, file), path.join(outDir, file));
  }
}

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag.startsWith('vscode-'),
        },
      },
    }),
    {
      name: 'copy-codicons',
      closeBundle() {
        copyCodicons(path.resolve(__dirname, '..', 'out', 'webview'));
      },
    },
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
