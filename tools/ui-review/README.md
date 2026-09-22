# UI Review Harness

Manual UI walkthrough tooling for the Forgejo Toolkit webviews. It launches an
**isolated** VS Code Extension Development Host (separate profile and extension
dir — your own VS Code is never touched) with CDP enabled, then drives it with
coordinate input and screenshots.

Written in TypeScript, run directly with `tsx` (no build step). `pnpm check` at
the repo root type-checks this package too.

## Prerequisites

- `code` on PATH.
- The extension built (`packages/forgejo-toolkit/out` + webview assets) — the
  dev host loads the built output, so rebuild after code changes.
- No Playwright browser download needed; only `connectOverCDP` is used.

## Commands

```bash
pnpm launch [workspacePath]   # start dev host (default workspace: D:\code\test)
pnpm kill                     # stop only the isolated dev host instance

pnpm ui shot <name>                  # CDP screenshot -> shots/<name>.png
pnpm ui click <x> <y> [name] [waitMs]
pnpm ui scroll <x> <y> <deltaY> [name]
pnpm ui drag <x1> <y1> <x2> <y2> [name]
pnpm ui type <text> [name]           # types into the focused element
pnpm ui key <key> [name]             # e.g. Escape, Enter, Tab
```

`UI_LOCALE=<locale> pnpm launch` passes `--locale` to VS Code (e.g. for
localized screenshot runs). Note: `--locale` alone may not stick — write
`{ "locale": "zh-cn" }` into `profile/argv.json` and install the matching
language pack into the isolated extensions dir instead:

```bash
code --extensions-dir="$PWD/extensions" --install-extension MS-CEINTL.vscode-language-pack-zh-hans
```

A throwaway git repo under `workspace/` (gitignored) with its `origin` set to
`https://forgejo.example.com/demo-user/demo-repo.git` gives the linked-repo
card clean, mock-backed data for screenshots.

Coordinates are read off the previous CDP screenshot (viewport, e.g. 1440x900).

## Known blind spots

- **Webviews are OOPIFs**: their DOM is unreachable via CDP frames. Use
  coordinate clicks + screenshots only.
- **Native OS dialogs** (VS Code modal messages such as the dirty-form confirm)
  are separate Win32 windows and never appear in CDP screenshots:

```bash
# Bring dev host to front and take a real system screenshot:
powershell -File src/win/activate.ps1 -OutFile "$PWD\shots\screen.png"

# Press a button on a native dialog owned by the dev host:
powershell -File src/win/dialog.ps1 -Keys '{ENTER}'   # Confirm (default)
powershell -File src/win/dialog.ps1 -Keys '{ESC}'     # Cancel
```

Both helpers locate the dev-host window by the isolated `--user-data-dir` of this
harness (`src/win/devhost.ps1`), not by window title, so they also work with a
localized UI (e.g. `UI_LOCALE=zh-cn`, where the title is `[扩展开发宿主] …`).

## Runtime state

`profile/` (persisted dev-host settings, incl. the onboarded mock instance),
`extensions/` and `shots/` are gitignored. The launcher pre-seeds
`forgejoToolkit.useMockApi: true`, so all data comes from the MSW handlers in
`packages/forgejo-toolkit/src/test/mocks/`.

## Release walkthrough checklist

Rebuild first — the dev host loads `out/`, so a walkthrough against a stale build
verifies the wrong code. Which build matters:

- **mock-backed walkthroughs** (everything below except the push-target and MCP
  items): `pnpm --filter forgejo-toolkit build:extension`, i.e. esbuild _without_
  `--production`. The production build strips `src/test/mocks/`
  (`FORGEJO_TOOLKIT_INCLUDE_MOCKS=false`), so with it the Dashboard lists no
  repositories and every request goes to the real network.
- **production-shaped walkthroughs** (install the packaged `.vsix` instead):
  `pnpm --filter forgejo-toolkit build`, and point an instance at a real server.

Then run through the flows below; each one covers behaviour that unit tests
cannot observe (native modals, real git, real MCP clients).

1. **Dirty PR worktree confirmation.** In an opened PR worktree leave an
   uncommitted edit (or make a local commit), then click "Open in Worktree" for
   the same PR again. Expect a modal naming the local work; `{ESC}` must keep
   both the directory and the `pr-<n>-<sha7>` branch. A clean but outdated
   worktree must be recreated without a prompt.
2. **Delete confirmations.** Release attachment (`×` in the release dialog),
   issue attachment, review-comment attachment and tracked time each ask for a
   host-side confirm before the API call, and `{ESC}` leaves the item in place.
   Items 9 and 10 below spell out the two attachment paths; the mock fixtures
   they need are already in place.
3. **Review comment editor.** Markdown preview renders (no permanent spinner)
   and `@`/`#` complete against the mock instance.
4. **Push-target guard (needs a real git repo).** Add
   `git config remote.origin.pushurl https://mirror.example.com/x.git` to the
   test workspace and trigger the publish / create-PR push: it must abort with
   the "push target does not belong" message and send no request.
5. **Notification actions.** With `forgejoToolkit.notificationPollingEnabled`
   off, "Mark all as read" is enabled once the list has loaded and disables
   itself after the reply.
6. **Actions pagination.** A repository with more than one page of runs appends
   on "Load more", keeps the loaded runs, and hides the button on the last page.
7. **Import errors.** Importing a corrupt JSON file shows the error in the
   preview instead of an empty list.
8. **MCP tools (needs a real instance + token).** In agent mode call
   `get_file_content` with `path: "../../../../notifications"`: expect a
   validation error, not a request to that endpoint; a large PR result must
   carry the truncation marker.
9. **Release attachment delete (mock-backed).** Dashboard → the repository
   (`demo-repo`) → `引用` → `Release` → the pencil on `Version 2.0.0` → in
   "编辑 Release" scroll to `附件` → the `×` on `release-notes.md`. The host asks
   "Delete this attachment?" (`确定删除此附件吗?`); `{ESC}` keeps the row,
   `{ENTER}` removes it and the debug log shows
   `DELETE …/releases/5/assets/10 → 204`.
   Fixtures this relies on: `mockRelease.assets` must list
   `mockReleaseAttachment` (the dialog only offers delete for attachments the
   release carries) and the release list handler must serve the fixture release —
   with `GET …/releases` answering `[]` the refs view says "no releases" and
   there is nothing to open. The attachment DELETE is stateful, so the confirmed
   case is observable (the row comes back on the next GET otherwise).
10. **Comment attachment delete (mock-backed).** Dashboard → the linked-repo
    card's `Issues` → issue `#1` → the comment's kebab (`⋮`) → `编辑` → in
    "编辑评论" the `附件` list shows `log.txt` → `删除` (marks it) → `保存` →
    decline the host confirmation. The timeline then shows
    "1 attachment(s) were not deleted: the confirmation was declined."
    (`有 1 个附件未删除：已取消确认。`) and the comment keeps its attachment.
    Fixtures this relies on: the timeline comment needs `type: 'comment'` (a
    comment without a type renders as a bare event and has no kebab menu) and a
    body referencing `/attachments/<uuid>` whose uuid matches the attachment
    fixture — the client only requests a comment's attachment list when its body
    contains such a reference.

Two behaviours that are easy to misread while driving the flows above:

- **Act promptly on a native modal.** The webview keeps a request timeout on the
  pending call; leaving a confirmation open while reading screenshots lets it
  expire, which surfaces as "Request timed out. Please try again."
  (`请求超时，请重试。`) and leaves the item untouched — that is the timeout, not
  a rejected delete. Retry and answer within a couple of seconds.
- **A confirmed delete only disappears once the fixtures are stateful.** Deletes
  that only answer `204` (release list, tracked time, dependencies, comment and
  release attachments) report back on the next GET, so `{ESC}` and `{ENTER}`
  look identical. `src/test/mocks/handlers.ts` keeps that state and
  `resetMockState()` restores it; starting the dev host fresh resets it too.
