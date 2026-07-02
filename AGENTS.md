# Forgejo Toolkit — Agent Guidelines

## Package scope

- Use `@cpf23333-forgejo-toolkit/` for all workspace packages, not `@forgejo/`.

## `@vscode-elements/elements` usage rule

Do **not** use any `@vscode-elements/elements` web component directly in `forgejo-toolkit` webview code (e.g. `<vscode-collapsible>`, `<vscode-button>`, `<vscode-textfield>`, etc.).

Every element used from `@vscode-elements/elements` **must** be wrapped by a typed Vue component defined in `packages/vscode-elements-vue/src/components`. Import and use the wrapper component instead. This ensures:

- Prop/emit/slot types are checked by `vue-tsc`.
- Vue-specific bindings (`v-model`, scoped slots, event modifiers) behave correctly.
- The public API of each element is explicit and stable across `@vscode-elements/elements` updates.

When you need a new element, create its wrapper in `packages/vscode-elements-vue/src/components` first, then export it from `packages/vscode-elements-vue/src/components/index.ts` and `packages/vscode-elements-vue/src/components/index.d.ts`.

## Lint / format

- Use `oxlint` and `oxfmt`.
- Run `pnpm lint` and `pnpm format` at the root before finishing.

## Type checking

- Run `pnpm check` at the root after any TypeScript or Vue change.
