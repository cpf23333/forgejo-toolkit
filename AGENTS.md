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
- Exception: `packages/forgejo-toolkit` itself is named `forgejo-toolkit` without a scope, because the package name doubles as the VS Code extension ID and extension IDs do not allow an `@scope/name` form. Do not "fix" this one into the scope.

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
- Confirmations for destructive host commands (delete\*/merge/dispatchWorkflow etc.) are enforced host-side: the host's message dispatch pops the modal itself before executing. Webview code must **not** call `showConfirm()` for these commands — that would double-prompt.
- Webview-side `showConfirm()` is only for pure UI-state confirmations that involve no host command (e.g. the discard-changes prompt in `ModalDialog.vue`).

## Project tracking documents

Keep these documents in sync with the actual codebase. Do not let them drift.

- `TODO.md` — short-term task list. It keeps only unfinished items and the
  context still needed; finished details live in the file's git log, and
  `FEATURES.md`'s **已完成** section is the delivered-feature record.
  - Remove an item when it ships — `TODO.md` intentionally has no **已完成**
    section.
  - Record a dropped idea's decision inline in its entry, or remove the item.
- `FEATURES.md` — feature inventory of what the plugin does for a user, classified by
  status: **进行中** / **已完成** / **未完成**, the last one grouped by plan horizon.
  Engineering, build and release work is not a feature and does not belong here.
  - A partially delivered feature goes in **进行中** with what is already there and what
    remains; per-task detail, blockers and next actions stay in `TODO.md`.
  - Move a feature to **已完成** when it is delivered, and drop entries that are no
    longer planned.
- `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` — documented workarounds and platform limitations.
  - Add an entry when a bug or limitation is accepted as "won't fix short-term".
  - Keep both language files in sync: same headings, same structure, equivalent meaning.
  - Explain _what_ happens, _why_, and the current workaround (if any).
- `docs/design/**` — decision records. They state what was decided and why; they are not a task
  list, so open work belongs in `TODO.md` (a design document may name the tracking entry, never
  hold the only copy of a pending item).

Run `node tools/tracking-audit/check.mjs` after touching any of them (CI runs it too). It enforces the
boundary above: `TODO.md` must have no completed/history heading, no checked boxes and a role header
(presence only — the audit does not read its wording); `FEATURES.md`'s **已完成** section must hold no open
work, so no line anywhere in it may carry a `待定`/`待实测`/`待实现`/`剩余`/`未实现`/`尚未实现`/`暂缓` marker, no line
in it may exceed 600 characters, and it too needs a role header; the two known-issues files must keep the
same heading count; and nothing anywhere may cite `TODO.md:<line>`, `FEATURES.md:<line>` or
`KNOWN_ISSUES.md:<line>` — cite the entry's title or a commit instead.

Run `node tools/api-audit/check.mjs` after touching `packages/forgejo-toolkit/src/api/client.ts` or
`docs/api-verification-checklist.md` (CI runs it too): every endpoint the client calls must appear in
the checklist, so a new call cannot ship unverified.

Run `node tools/docs-audit/check.mjs` after touching any markdown file (CI runs it too): a cited file must
exist and a cited line must fit inside it, markdown links and named 「heading」 references must resolve, a
paired `foo.md`/`foo.zh.md` must keep the same headings/lists/fences/tables, and headings must not repeat
among siblings or skip a level.

## Internationalization (i18n)

### Webview strings

- Keep all webview UI strings in JSON files under `packages/forgejo-toolkit/webview/src/i18n/`:
  - `en.json` for English (source of truth)
  - `zh.json` for Chinese
- Use namespaced keys that reflect the screen or component, e.g. `dashboard.tabs.repositories`, `settings.addInstanceTitle`, `dashboard.detail.openIssue`.
- Add new keys to **both** language files in the same PR. Keep English and Chinese translations equivalent in meaning.
- Do **not** embed user-facing strings directly in `.vue` files or TypeScript code. Exception: purely technical identifiers, log messages, or debug strings that are never shown to users.
- Do **not** use `<i18n>` blocks inside `.vue` files. Centralized JSON is easier to audit, search, and translate.
- Prefer flat, readable keys over deeply nested structures. Three levels (`section.group.key`) is usually enough.
- When reusing the same concept in multiple places, use a shared key rather than duplicating text.
- Run `pnpm check` after editing i18n files to catch missing interpolation arguments or type mismatches.

### Host-side strings

- Extension-host user-visible text goes through `vscode.l10n.t(...)`, with the translations in `packages/forgejo-toolkit/l10n/bundle.l10n.json` (English) and `bundle.l10n.zh-cn.json` (Chinese). Manifest strings (setting and command names/descriptions) use `packages/forgejo-toolkit/package.nls.json` and `package.nls.zh-cn.json` instead. Keep both files of a pair complete — add the key to both in the same change — and keep the Chinese translation equivalent to the English source.
