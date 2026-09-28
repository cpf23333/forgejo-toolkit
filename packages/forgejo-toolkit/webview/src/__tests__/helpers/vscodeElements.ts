/**
 * The `<vscode-*>` custom elements the webview renders, with the stub markup a
 * test would use for them.
 *
 * `webview/vite.config.mts` compiles every `vscode-` tag as a custom element
 * (`isCustomElement: (tag) => tag.startsWith('vscode-')`), so Vue never resolves
 * them as components and `config.global.stubs` cannot actually replace them in a
 * test: a component that starts rendering an element jsdom knows nothing about
 * keeps rendering an inert tag (its v-model and its events do nothing) and the
 * test still passes. That is what `./vscodeElements.test.ts` guards instead — it
 * scans the webview sources and fails when a rendered tag is missing here, or
 * when a tag listed here is no longer rendered, so this list and the components
 * cannot drift apart.
 *
 * The tags are the ones `@vscode-elements/elements` registers (see
 * `webview/src/main.ts`); their names are not interchangeable — `vscode-textfield`
 * is not `vscode-text-field`.
 */
export const VSCODE_ELEMENT_STUBS = {
  'vscode-button': { template: '<button data-stub="vscode-button"><slot /></button>' },
  'vscode-checkbox': { template: '<input type="checkbox" data-stub="vscode-checkbox" />' },
  'vscode-context-menu': { template: '<div data-stub="vscode-context-menu"><slot /></div>' },
  'vscode-icon': { template: '<span data-stub="vscode-icon" :class="$attrs.class"><slot /></span>' },
  'vscode-option': { template: '<option data-stub="vscode-option"><slot /></option>' },
  'vscode-progress-ring': { template: '<div data-stub="vscode-progress-ring"><slot /></div>' },
  'vscode-radio': { template: '<input type="radio" data-stub="vscode-radio" />' },
  'vscode-radio-group': { template: '<div data-stub="vscode-radio-group"><slot /></div>' },
  'vscode-single-select': { template: '<select data-stub="vscode-single-select"><slot /></select>' },
  'vscode-textfield': { template: '<input data-stub="vscode-textfield" />' },
  'vscode-tree': { template: '<div data-stub="vscode-tree"><slot /></div>' },
  'vscode-tree-item': {
    template:
      '<div data-stub="vscode-tree-item" :data-branch="$attrs.branch" :data-level="$attrs.level"><slot /><slot name="actions" /></div>',
  },
} satisfies Record<string, { template: string }>;

/** The tag names in {@link VSCODE_ELEMENT_STUBS}, for the drift guard. */
export const VSCODE_ELEMENT_TAGS: string[] = Object.keys(VSCODE_ELEMENT_STUBS);
