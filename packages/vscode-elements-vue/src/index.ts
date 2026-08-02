export * from './components/index.ts';

// Consumers should register the elements by importing the bundled build:
//   import '@vscode-elements/elements/dist/bundled.js';
// This avoids ESM resolution issues with the package's internal modules.
