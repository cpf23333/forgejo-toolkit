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

## License and attribution

- This project is licensed under the MIT License. Do not change the license without explicit approval.
- All workspace packages must include `"license": "MIT"` in their `package.json`.
- The `LICENSE` file at the repository root must be preserved in distributions.
- When adding new dependencies, run `pnpm licenses list --prod` and ensure no strong copyleft licenses (GPL, AGPL, LGPL, MPL, EPL, etc.) are introduced.
- The UI/UX is inspired by GitLens in a general sense (commit list layout, repository dashboard), but all code is independently implemented. Do **not** copy code, icons, colors, animations, or distinctive wording from GitLens or any other project without proper attribution and license compatibility.
- Never copy code from GitLens' proprietary `src/plus/` directory. Only refer to GitLens' MIT-licensed core code if needed, and preserve its copyright notice if any code is adapted.
- This plugin communicates with Forgejo via its standard REST API. It does not incorporate Forgejo source code and is not an AGPL derivative work. Do not embed Forgejo code unless you are prepared to comply with AGPL.

## Type checking

- Run `pnpm check` at the root after any TypeScript or Vue change.

## Internationalization (i18n)

- Keep all UI strings in JSON files under `packages/forgejo-toolkit/webview/src/i18n/`:
  - `en.json` for English (source of truth)
  - `zh.json` for Chinese
- Use namespaced keys that reflect the screen or component, e.g. `dashboard.tabs.repositories`, `settings.addInstanceTitle`, `dashboard.detail.openIssue`.
- Add new keys to **both** language files in the same PR. Keep English and Chinese translations equivalent in meaning.
- Do **not** embed user-facing strings directly in `.vue` files or TypeScript code. Exception: purely technical identifiers, log messages, or debug strings that are never shown to users.
- Do **not** use `<i18n>` blocks inside `.vue` files. Centralized JSON is easier to audit, search, and translate.
- Prefer flat, readable keys over deeply nested structures. Three levels (`section.group.key`) is usually enough.
- When reusing the same concept in multiple places, use a shared key rather than duplicating text.
- Run `pnpm check` after editing i18n files to catch missing interpolation arguments or type mismatches.
