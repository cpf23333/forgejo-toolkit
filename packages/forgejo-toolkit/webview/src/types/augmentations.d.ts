import type {} from 'vue';

/**
 * `data-vscode-context` is the one `data-*` attribute this project puts on native
 * elements on purpose: it is how a row publishes the context keys for VS Code's
 * contributed `webview/context` items (`utils/contextMenu.ts`). It has to be declared
 * because `strictTemplates` (see `webview/tsconfig.json`) rejects an unknown attribute
 * on a native element, and the issue and pull-request list rows are plain
 * `div.item-card` elements rather than `vscode-*` ones.
 */
declare module '@vue/runtime-dom' {
  interface ReservedProps {
    slot?: string;
    'data-vscode-context'?: string;
  }
}

declare module 'vue' {
  interface ReservedProps {
    slot?: string;
    'data-vscode-context'?: string;
  }
}
