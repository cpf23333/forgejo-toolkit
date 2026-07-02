export { default as vscodeElementsVue } from './vite-plugin.ts';
export type { VscodeElementsVueOptions } from './vite-plugin.ts';
export * from './components/index.ts';

// Consumers should register the elements by importing the bundled build:
//   import '@vscode-elements/elements/dist/bundled.js';
// This avoids ESM resolution issues with the package's internal modules.
