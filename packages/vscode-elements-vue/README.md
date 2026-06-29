# @forgejo/vscode-elements-vue

Vue 3 adapter for [@vscode-elements/elements](https://www.npmjs.com/package/@vscode-elements/elements).

## Features

- Type definitions for all `vscode-*` custom elements.
- Vite plugin that auto-configures Vue's `isCustomElement` for `vscode-*` tags.
- Optional thin Vue wrapper components for common elements.

## Usage

### Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { vscodeElementsVue } from '@forgejo/vscode-elements-vue';

export default defineConfig({
  plugins: [
    vscodeElementsVue(),
  ],
});
```

The plugin accepts the same options as `@vitejs/plugin-vue` and extends
`compilerOptions.isCustomElement` to recognize every tag starting with `vscode-`.

### Load elements and styles

```ts
// main.ts
import { createApp } from 'vue';
import App from './App.vue';
import '@vscode-elements/elements/dist/bundled.js';

createApp(App).mount('#app');
```

### In a Vue SFC

```vue
<template>
  <vscode-button @click="onClick">Click me</vscode-button>
</template>
```

### Wrapper components

```vue
<script setup lang="ts">
import { VscodeButton, VscodeTextfield } from '@forgejo/vscode-elements-vue/components';
</script>

<template>
  <VscodeTextfield v-model="url" placeholder="Forgejo URL" />
  <VscodeButton variant="primary" @click="connect">Connect</VscodeButton>
</template>
```

## Implementation notes

- Runtime entry points point to the TypeScript source files so the package can be consumed directly inside a pnpm workspace.
- Type entry points (`.d.ts`) are separate files that import without `.ts` extensions, keeping TypeScript happy for consumers that use classic `node` module resolution.
- The bundled build of `@vscode-elements/elements` is imported explicitly to avoid ESM resolution issues with the library's internal modules.
