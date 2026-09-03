# Forgejo Toolkit — Agent Guidelines

## Agent self-check on every resumed or compacted session

The runtime may compact or drop earlier context, including the cached copy of this file. As a result, the system prompt's "applicable AGENTS.md instructions" block can appear empty or stale after a long session.

**Before any code change, build, or git mutation:**

1. Re-read `AGENTS.md` from disk if it is not clearly present in the current context.
2. Verify whether the intended action is allowed by the rules below.
3. When in doubt, stop and ask the user instead of assuming prior permission still applies.

This rule takes precedence over any compacted summary, TODO list, or earlier user instruction that may have been lost or simplified.

## Highest-priority rules (must survive context compaction)

- On every session resume, context compaction, or whenever this file is not clearly present in the current context, re-read `AGENTS.md` from disk.
- Do not perform any build, commit, push, reset, rebase, checkout, or code change until you have re-read and confirmed this file.
- If any rule in this file conflicts with a compacted summary, TODO list, or earlier user instruction, this file takes precedence. When in doubt, stop and ask the user.

## Package scope

- Use `@cpf23333-forgejo-toolkit/` for all workspace packages, not `@forgejo/`.

## Code content

- Do **not** include explicit IP addresses in source code, tests, fixtures, or documentation examples. Use placeholder domain names such as `forgejo.example.com`, `codeberg.org`, or `example.com` instead.

## UI/UX skill

This project includes the `impeccable` UI/UX skill at `.agents/skills/impeccable/SKILL.md`. Load and follow it when doing design, redesign, critique, or polish work on webview interfaces.

When applying that skill, keep the VS Code native look and feel: prefer `vscode-elements` components, Codicons, and VS Code theme tokens over custom branding or marketing-style visuals.

Review and update `.agents/skills/impeccable/` periodically or whenever its guidance conflicts with this project's constraints or a newer version provides better rules.

## `@vscode-elements/elements` usage rule

`@vscode-elements/elements` web components are used directly in `forgejo-toolkit` webview code. The `packages/vscode-elements-vue` wrapper package has been removed.

Use the underlying web components directly and declare their types in `packages/forgejo-toolkit/webview/src/types/global.d.ts` when needed. Do not re-introduce a wrapper package unless there is a strong, well-documented reason.

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
- Reporting that a change is "done" or that checks pass is **not** an implicit request to commit. Wait for an explicit commit instruction such as "提交" or "commit".
- **Authorization is per-change.** A previous instruction such as "commit these files" or "submit it" applies only to the change it was given for. It does **not** extend to later fixes, follow-ups, or new changes.
- Before every git mutation, explicitly verify that the user authorized it for the **current** change. When in doubt, stop and ask.
- If a commit was made by mistake, stop and ask the user before undoing it.
- When the user asks to commit, write the commit message in English.

### Required commit confirmation workflow

To prevent accidental commits, the agent **must** follow this exact sequence for every change that may need to be committed:

1. Complete the requested work (write files, run checks/tests, verify).
2. Report the status to the user, including:
   - What files were modified or created.
   - The result of `pnpm check` and any relevant tests.
3. **Explicitly ask** "是否提交？" (or "Shall I commit?" if the conversation is in English).
4. Run `git commit` **only** after the user replies with an explicit commit instruction such as "提交" or "commit".

The following are **not** implicit requests to commit, even if they result in file changes:

- "写进 ..." / "write it into ..."
- "更新 ..." / "update ..."
- "完成 ..." / "finish ..."
- "处理 ..." / "handle ..."
- "添加到 ..." / "add it to ..."
- Any task description that does not contain an explicit commit instruction.

If the user says "提交刚才的改动" or similar, that authorization applies **only** to the specific change referenced. It does **not** authorize committing any follow-up edits, cleanups, or doc syncs made afterwards.

## Codeberg hosting and resource usage

This project is currently hosted on Codeberg. Codeberg's Terms of Use discourage projects whose resource consumption is severely mismatched with their community size, as well as projects that appear to be autonomously maintained by LLM agents.

To keep the project welcome on Codeberg:

- **No autonomous CI agents.** CI must only validate code; it must not commit, push, release, merge, or otherwise modify the repository on its own.
- **Keep the git repository small.** Do not commit `node_modules`, build outputs (`.vsix`, `out/`, `dist/`), large media files, or generated artifacts. The `.gitignore` already covers these; do not bypass it.
- **CI must be human-triggered.** CI must not run autonomously on every push or on a schedule. Use `workflow_dispatch` or equivalent manual triggers. The CI itself may run lint, typecheck, tests, builds, or even multi-platform matrix jobs when a human explicitly starts it.
- **Keep release artifacts off git.** Attach `.vsix` files to Codeberg Releases or the VS Code Marketplace, not to the git repository.
- **Preserve human maintenance signals.** Commit messages, issue responses, and PR reviews should clearly show human oversight. Do not use bots for auto-merging or autonomous releases.

## Webview runtime limitations

- VS Code webviews run inside a sandboxed iframe without `allow-modals`. `window.alert`, `window.confirm`, and `window.prompt` are blocked by the browser and must **never** be used in webview code.
- Always use the host-backed helpers exposed by `useAppState()`:
  - `showInputBox()` for text input.
  - `showConfirm()` for yes/no confirmation.
- The `webview/src/types/webview-window.d.ts` file marks these APIs as `@deprecated` as a reminder.
- `showConfirm()` renders as a native OS dialog (VS Code modal message), on purpose: it matches VS Code's own destructive-action confirmations and blocks the whole window. Do **not** reimplement confirmations inside the webview unless native dialogs become too limited (e.g. multi-choice with details).
- Native dialogs are invisible to CDP screenshots during UI testing; use a system-level screenshot plus simulated keystrokes to inspect and dismiss them. The `tools/ui-review/` harness packages all of this (isolated dev host, CDP driver, native-dialog helpers) — see its README.

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
