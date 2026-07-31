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

### Exception: `<vscode-tree>` / `<vscode-tree-item>`

`<vscode-tree>` and `<vscode-tree-item>` may be used directly in `packages/forgejo-toolkit/webview/src/views/Dashboard.vue`. The Vue wrapper cannot reliably forward the Lit context that `<vscode-tree-item>` requires, which causes runtime errors and prevents the tree from rendering.

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

## Build commands

- Do **not** run `pnpm build`, `pnpm -r run build`, `vite build`, `node esbuild.js`, or any other build command yourself.
- Only run `pnpm check` (and `pnpm format:fix` when needed). The user will run builds separately.

## Git mutations

- Do **not** run `git commit`, `git push`, `git reset`, `git rebase`, `git checkout`, or any other git mutation command without explicit user instruction.
- The user decides when and what to commit. It is safe to stage files (`git add`) only when the user explicitly asks for it.
- **Never auto-commit after finishing a change.** Even if the change looks complete, self-contained, or passing all checks, stop and report the status instead of committing.
- If a commit was made by mistake, stop and ask the user before undoing it.
- When the user asks to commit, write the commit message in English.

## Webview runtime limitations

- VS Code webviews run inside a sandboxed iframe without `allow-modals`. `window.alert`, `window.confirm`, and `window.prompt` are blocked by the browser and must **never** be used in webview code.
- Always use the host-backed helpers exposed by `useAppState()`:
  - `showInputBox()` for text input.
  - `showConfirm()` for yes/no confirmation.
- The `webview/src/types/webview-window.d.ts` file marks these APIs as `@deprecated` as a reminder.

## Project tracking documents

Keep these documents in sync with the actual codebase. Do not let them drift.

- `TODO.md` — short-term task list.
  - Move items from **进行中** to **已完成** when they ship.
  - Move dropped ideas to **已完成** with a note, or remove them.
- `ROADMAP.md` — high-level feature overview.
  - Move completed features to the **已完成** section.
  - Remove or rephrase items that are no longer planned.
- `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` — documented workarounds and platform limitations.
  - Add an entry when a bug or limitation is accepted as "won't fix short-term".
  - Keep both language files in sync: same headings, same structure, equivalent meaning.
  - Explain _what_ happens, _why_, and the current workaround (if any).

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
