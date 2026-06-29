import type { PluginOption } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { Options as VuePluginOptions } from '@vitejs/plugin-vue';

export interface VscodeElementsVueOptions {
  /**
   * Options forwarded to the underlying @vitejs/plugin-vue.
   * The `isCustomElement` compiler option is automatically extended
   * to recognize all `vscode-*` tags.
   */
  vue?: VuePluginOptions;
}

/**
 * Vite plugin that configures @vitejs/plugin-vue for @vscode-elements/elements.
 *
 * It automatically marks every tag starting with `vscode-` as a custom element,
 * preventing Vue from warning about unknown elements and from treating their
 * attributes as component props.
 */
export default function vscodeElementsVue(options: VscodeElementsVueOptions = {}): PluginOption {
  const userCompilerOptions = options.vue?.template?.compilerOptions;
  const userIsCustomElement = userCompilerOptions?.isCustomElement;

  return vue({
    ...options.vue,
    template: {
      ...options.vue?.template,
      compilerOptions: {
        ...userCompilerOptions,
        isCustomElement: (tag: string) => {
          if (tag.startsWith('vscode-')) {
            return true;
          }
          if (typeof userIsCustomElement === 'function') {
            return userIsCustomElement(tag);
          }
          return false;
        },
      },
    },
  });
}
