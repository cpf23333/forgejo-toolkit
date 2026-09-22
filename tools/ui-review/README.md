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

## Runtime state

`profile/` (persisted dev-host settings, incl. the onboarded mock instance),
`extensions/` and `shots/` are gitignored. The launcher pre-seeds
`forgejoToolkit.useMockApi: true`, so all data comes from the MSW handlers in
`packages/forgejo-toolkit/src/test/mocks/`.

## Release walkthrough checklist

Rebuild first (`pnpm --filter forgejo-toolkit build`) — the dev host loads
`out/`, so a walkthrough against a stale build verifies the wrong code. Then
run through the flows below; each one covers behaviour that unit tests cannot
observe (native modals, real git, real MCP clients).

1. **Dirty PR worktree confirmation.** In an opened PR worktree leave an
   uncommitted edit (or make a local commit), then click "Open in Worktree" for
   the same PR again. Expect a modal naming the local work; `{ESC}` must keep
   both the directory and the `pr-<n>-<sha7>` branch. A clean but outdated
   worktree must be recreated without a prompt.
2. **Delete confirmations.** Release attachment (`×` in the release dialog),
   issue attachment, review-comment attachment and tracked time each ask for a
   host-side confirm before the API call, and `{ESC}` leaves the item in place.
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

