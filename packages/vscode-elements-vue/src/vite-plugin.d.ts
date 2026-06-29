import type { PluginOption } from 'vite';
import type { Options as VuePluginOptions } from '@vitejs/plugin-vue';

export interface VscodeElementsVueOptions {
  vue?: VuePluginOptions;
}

export default function vscodeElementsVue(options?: VscodeElementsVueOptions): PluginOption;
