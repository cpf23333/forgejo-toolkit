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
  dev host loads the built output, so rebuild after code changes. **The rebuild
  is the maintainer's step**: `AGENTS.md` forbids the agent from running build
  commands, so the harness only ever consumes an existing `out/`.
- The build has to be **mock-backed** for a launch without `--real-api`: the
  launcher reads `packages/forgejo-toolkit/out` and refuses to start a window
  when the mock API is not compiled into it (see "Mock-backed runs and the
  real-API opt-in" below).
- No Playwright browser download needed; only `connectOverCDP` is used.

## Commands

These scripts live in `tools/ui-review/package.json`, not in the root manifest, so
they have to be selected with `--filter` from the repository root (or run from the
harness directory). `pnpm launch` at the root fails with
`Command "launch" not found`.

```bash
# From the repository root:
pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch [workspacePath] [--real-api]  # start dev host (default workspace: D:\code\test)
pnpm --filter @cpf23333-forgejo-toolkit/ui-review kill                   # stop only the isolated dev host instance

pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui shot <name>  # CDP screenshot -> shots/<name>.png
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui click <x> <y> [name] [waitMs]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui rclick <x> <y> [name] [waitMs]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui scroll <x> <y> <deltaY> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui drag <x1> <y1> <x2> <y2> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui hover <x> <y> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui type <text> [name]  # types into the focused element
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui key <key> [name]    # e.g. Escape, Enter, Tab
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui eval <js>           # evaluates in the workbench page, prints the result

# Equivalent, from the harness directory (the `src/...` paths below assume it):
cd tools/ui-review
pnpm launch [workspacePath] [--real-api]
pnpm kill
pnpm ui shot <name>
```

`UI_LOCALE=<locale> pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch`
passes `--locale` to VS Code (e.g. for localized screenshot runs). Note:
`--locale` alone may not stick — write `{ "locale": "zh-cn" }` into
`profile/argv.json` and install the matching language pack into the isolated
extensions dir instead (run from `tools/ui-review/`):

```bash
code --extensions-dir="$PWD/extensions" --install-extension MS-CEINTL.vscode-language-pack-zh-hans
```

A throwaway git repo under `workspace/` (gitignored) with its `origin` set to
`https://forgejo.example.com/demo-user/demo-repo.git` gives the linked-repo
card clean, mock-backed data for screenshots.

Coordinates are read off the previous CDP screenshot (viewport, e.g. 1440x900).

Each `ui` invocation is its own CDP connection, so a `click` does not always take
focus before the `type` of the **next** invocation runs. Measured in one acceptance
run: the first click on a newly added form field silently swallowed all 27 typed
characters (the `shot` showed an empty field), while the same click+type on a fresh
form had worked. The pattern that held up is one step per invocation —
`click` → `key Control+a` → `key Delete` → `type` — checking each step's screenshot
(every command already writes one under `shots/`). A screenshot is the only
trustworthy check here: the command exits 0 whether or not the value landed, so
never read a bare success as "the field is filled".

## Mock-backed runs and the real-API opt-in

The mock API (msw and the fixtures in
`packages/forgejo-toolkit/src/test/mocks/`) exists in a build only when that build
was made **without** `--production`: `packages/forgejo-toolkit/esbuild.js`
_defines_ `process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS` at build time (`'true'`
without `--production`, `'false'` with it) and `src/extension.ts` guards its
dynamic mock import with it, so a production build dead-code-eliminates the whole
module. Nothing this harness can set at launch time brings it back — which is why
the launcher **reads the build** (`packages/forgejo-toolkit/out`, main bundle and
chunks) before it starts a window and refuses when the answer is "this build can
only talk to the network":

```
Refusing to launch: this dev host would poll a real server.

  build:     …\packages\forgejo-toolkit\out  (no mock API compiled in)
             a production build defines FORGEJO_TOOLKIT_INCLUDE_MOCKS=false, which
             dead-code-eliminates src/test/mocks/ (msw and its fixtures) — see
             packages/forgejo-toolkit/esbuild.js
  profile:   …\tools\ui-review\profile
  instances: <name> <url> (whatever the profile's mcp-instances.json holds)

Two ways forward:
  --real-api   run against those instances anyway. This is the explicit opt-in;
               polling here is read-only, but instance-wide actions reach these servers
               (for example "mark all as read", which changes data on every configured instance)
  rebuild without --production, so the mock API intercepts every request:
               pnpm --filter forgejo-toolkit build:extension
```

The refusal happens before anything is created or spawned, so a production build
costs a message rather than a surprise request. Three rules complete the picture:

- **`--real-api` is the opt-in**, accepted by both `launch` and `dual launch`. It
  prints a warning naming the profile, the instance(s) they will use and what that
  means for instance-wide actions, and it pins `forgejoToolkit.useMockApi` to
  `false` in the profile so a mock-inclusive build cannot intercept the requests
  the operator asked to send. Every run pins that setting to the mode it was
  started for, so the profile always describes the last run.
- **A mock-capable build changes nothing else**: without the flag the run is
  mock-backed exactly as before, and the launcher says which literal it matched —
  if the profile nevertheless has `forgejoToolkit.useMockApi: false`, that is
  reported instead of being silently overridden.
- **Detection is marker-based, not size-based**: the scan looks for literals that
  exist only in `src/test/mocks/` (`[mocks] no handler matched`,
  `(a test must never reach the real network).`, and two fixture sentences from
  `data/repositories.ts`). They are reachable from `startMockServer()`, so a build
  that keeps the module keeps them; `src/apiMode.test.ts` additionally asserts
  every marker still exists in the mock sources, so rewording a fixture fails a
  test instead of silently reporting every build as production.

## Shared-profile dual-window mode

Everything above is one isolated profile per launch, which can never produce "two
windows that share `globalStorage`". That scenario is what the multi-window
polling lease and the MCP broker handover are about (`docs/design/multi-window-polling-lease.md`
§10.2, §11.2), so `src/dual.ts` adds it as a mode on top of the existing launcher:

- the **first** window is launched exactly as `pnpm launch` does (same
  `--user-data-dir`, same CDP port, the same build-capability gate and
  `--real-api` opt-in — see "Mock-backed runs and the real-API opt-in" above);
- the **second** window is a second window _of that same profile_, opened with
  **Ctrl+Shift+N inside the running instance** — not with
  `code --new-window <folder>`, which for an already-running profile only raises
  the existing window (measured, §10.2);
- both windows stay addressable: the driver talks to one by CDP target id, and the
  mode labels them `window1` (launched) and `window2` (opened second);
- each window's extension host is reported by pid and can be killed on its own.

The mode has been run end to end (2026-09-27, after the build); see "What the first
real run established" below for what that settled and "Still unproven" for what it
did not.

```bash
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual launch [workspace] [--real-api]  # first window, then window2
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual verify              # one profile, two windows, one exthost each
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual targets             # CDP target ids to address each window
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual windows             # each window's log directory
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual logs <1|2|all> [--preset extension|exthost|mcp|any] [--grep X] [--tail N] [--follow]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual kill <1|2> [--print-command]  # Stop-Process -Force that window's exthost
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual close               # stop the dev host, drop the session state
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual state               # print the recorded session state as JSON
```

`dual launch` records the session in `dual-window.json` (gitignored), which is what
makes `dual logs` read _the session this mode launched_ instead of "the newest logs
on disk". A second window that never appears is a hard failure on purpose: two
windows of two different profiles would look identical in the logs while proving
nothing about the lease. `CDP_PORT`, `UI_WORKSPACE` and `UI_LOCALE` are read the same
way `pnpm launch` reads them, and because the second window is opened from the
already-running instance, `UI_LOCALE` applies to **both** windows.

Useful options: `--timeout <ms>` (how long to wait for window2, default 60000),
`--no-wait-window` (skip waiting for the log directories),
`--system-keystroke` (see the traps below), `--real-api` (allow this run to poll the
real instance instead of the mock API; it is refused without it when the build has
no mock API compiled in). The driver addresses a window either
positionally or by target id (`src/ui.ts` takes these, and they must come before
the command):

```bash
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui --target <id from "dual targets"> shot w2-home
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui --window 2 shot w2-home
```

Prefer `--target`: the ids `dual launch` recorded are the only thing that names a
window stably. `--window 2` is resolved through that recorded id, so it does mean
the same window on every call — but only while the session file exists; the
positional fallback (no session) is just "the page Playwright listed second", and
that order was measured to vary between connections. `dual targets` prints each
window's recorded id next to its title, so copy the id from there.

### Smoke scenario: two windows, one profile

What this is for (§10.2, §11.2): **which window is polling/leader**, **whether a
handover happened and how long it took**, and **whether the survivor kept working**
— the three questions the lease work has to answer with evidence.

1. **Clean start.** Rebuild (the maintainer's step — see Prerequisites), then make
   sure no dev host is left over:
   `pnpm kill` (it stops only Code.exe processes whose command line mentions this
   directory), and remove a stale `dual-window.json` with `dual close`.
2. **Launch.** `dual launch D:\code\forgejo-toolkit`. Expect both windows to open
   (the second one comes to the front), a line per window naming its CDP target id
   and title, and a summary naming each window's extension-host pid and log
   directory. The chord is sent up to three times with a focused window first,
   because the first `Ctrl+Shift+N` over CDP can be swallowed: in the run of
   2026-09-27 attempt 1 produced nothing and attempt 2 opened the window.
3. **Verify.** `dual verify` must end with
   `dual verify OK: two windows, one profile, one extension host each`. It re-reads
   the process table and fails on more than one `--user-data-dir`, on a profile that
   is not the recorded one, and on a window whose extension host is not running. The
   number of processes it _classifies_ as window roots is printed as a note rather
   than enforced: measured, a dev host is **one** root process (plus one renderer per
   window), so that count being one is expected and not a problem (see "Still
   unproven"). `dual targets` should list exactly two workbench pages, labelled
   `window1` / `window2` from the ids `dual launch` recorded; a third line reading
   `page[N] (unrecorded)` means the mode is looking at a window it did not launch
   (matching is by recorded id, never by position).
4. **Watch the two windows separately.** Each window's logs are under
   `profile/logs/<session>/window<N>/`; `window<N>` is VS Code's own numbering
   (the second window can be `window4`, which is why the mode maps label → directory
   through the extension-host pid recorded in `exthost/exthost.log`). The extension's
   output channel is picked from the newest `exthost/output_logging_*/`
   `N-Forgejo Toolkit.log` in that directory, so a window that reloaded (new
   channel) is not confused with the previous session:
   `dual logs 1 --preset extension --grep "poll" --follow` in one terminal and
   `dual logs 2 ...` in another is the intended way to watch a handover live.
   `--preset exthost` reads `exthost.log` (activation and termination lines),
   `--preset mcp` the `mcpServer.*.log` sinks described under "Verifying what
   VS Code's own MCP client does" in **Known blind spots** below (the broker itself is
   documented in `docs/architecture/mcp-server.md`, not in this README).
5. **Read the evidence.** Where to look, per question:
   - _who is leader_ — the lease line in the window's own channel, per `§7.1` of the
     design doc, with a fixed field order: `role=<leader|follower|degraded>`, then
     `action=`, `reason=`, `pid=`, `nonce=` (the owner nonce's first 8 chars),
     `focused=`, `focusedForMs=`, `at=`, and `polling=<unchanged|suppressed>` last.
     Stage 2 ships these lines, so this is a grep rather than a review of the
     implementation against §7.1: a survivor's takeover is
     `action=claim reason=follower-takeover-expired` (or `…-absent` /
     `…-accelerated`), the holder giving the lease up is `action=step-down`, and a
     window that gives the mechanism up is
     `action=degraded-to-full-speed reason=lease-unavailable`.
   - _how long the handover took_ — compare the stepping-down line in the old
     window with the claiming line in the new one, both timestamped and in different
     directories, which is exactly why the mode reports two log directories instead
     of one log stream.
   - _the survivor kept working_ — the surviving window keeps writing to its own
     channel and keeps answering `pnpm ui --window <n>`; the killed window's channel
     simply stops.
     An adjacent handover-shaped check is the MCP broker (already delivered): the
     exact broker line lives in exactly one window's channel —
     `[INFO] … MCP broker listening at \\.\pipe\forgejo-toolkit-mcp-<hash>`.
     `dual logs all --preset extension --grep "MCP broker"` should show it in one
     window and nothing in the other. **Caveat measured in the first real run:** that
     line only appears once an MCP client connects, and the endpoint is derived from
     the _user_ profile (`sha256(username + homedir)`), not from `--user-data-dir` —
     so next to a running real VS Code the dev host steps aside and the line never
     appears in either window. Redirect `USERPROFILE`/`HOME` before launching (as
     "Broker verification needs its own home directory" in **Known blind spots** below
     says) if this is the check you want. What the dual-window
     run _does_ show without any broker is that both windows activate the extension
     independently — `ExtensionService#_doActivateExtension cpf23333.forgejo-toolkit`
     plus its own `Extension host with pid <n> started` in **each** window's
     `exthost.log`, with two different pids.
   - _the gate itself_ — stage 2 makes the coordination visible in the two channels:
     the follower logs `action=polling-gate reason=suppressed` (with
     `polling=suppressed`, as every line of a gated window does) and its poller sends
     **no** `/notifications` request while it stays a confirmed follower, so an idle
     follower channel and a request log carrying only the owner's polls are the
     mechanism working, not a failure. The owner's lines all say
     `polling=unchanged`. `forgejoToolkit.multiWindowLease` (default `true`) is read
     live: turning it off or back on takes effect **without a window reload**, and the
     supervisor logs `action=stop reason=setting-off` as it gives the lease up.
6. **Crash one window.** `dual kill 2` → run it once with `--print-command` first
   if you want to see the exact command (`Stop-Process -Id <pid> -Force`). Expect:
   only window2's extension host dies (measured: window1's pid kept running, the
   choice is re-checked against the process table before `Stop-Process` runs), the
   app stays up, and a killed extension host never runs `deactivate()` — precisely
   the shape the lease must survive, since the surviving window has to take over.
   That takeover does **not** wait out the 35 s expiry: the implementation treats a
   dead holder pid as immediately stale, so the survivor claims on its next 2 s tick,
   with the 35 s expiry left as the fallback for a holder whose pid cannot be probed.
   Measured, and recorded in `docs/design/multi-window-polling-lease.md` §11.2's hard-kill bullet: **14.1 s after the holder's
   last heartbeat, ~11–13 s after the kill**, the pid probe short-circuiting the
   expiry wait; the acceptance run behind stage 2 measured **4.754 s** from the kill
   to the first post-takeover poll (0.894 s of that after the harness command
   returned; 11 ms from claim to gate). After the kill, `dual verify` fails with
   `window2: extension host pid <n> (from its log) is not running any more` — that is
   the expected failure of the two-window invariant, not a harness bug.
7. **Reload the victim.** Reload window2 from the palette (which leaves the app
   running): its extension host restarts, a _new_ `output_logging_*` directory
   appears in the same window directory, and `dual logs 2 --preset any` picks it up
   so you can read what the returning window did. Note `dual kill` is not this path:
   see the trap below for what force-killing the extension host does to the window.
8. **Clean up what you created.** `pnpm kill` (or `dual close`) stops the dev host,
   `dual close` also clears `dual-window.json`. The dev host leaves its
   `profile/` (settings, the shared `globalStorage`, `logs/`) and `extensions/`
   behind by design — both are gitignored, and nothing outside
   `tools/ui-review/` was touched. If you started this mode next to your own VS
   Code, check with `Get-Process Code` / `pnpm kill` that nothing of the harness is
   left; only the profile and the processes are the mode's to clean up.
   **A failed launch no longer leaves orphans**: `dual launch` writes
   `dual-window.json` as soon as window1 is identified (before the keystroke, which
   is where it is most likely to fail), so `dual close` works from that point on.
   Both failure paths print the state-file path and the cleanup command.

### Traps this mode has to work around

- **`code --new-window <folder>` is not the way to open window2.** Against the same
  profile it just raises the existing window (measured, §10.2), so the mode never
  uses it and refuses to continue when the number of workbench pages on the CDP port
  did not grow. That refusal is the point: silently ending up with two profiles
  would make every later observation meaningless.
- **`/json/list` does not list windows in creation order, and neither does
  Playwright reliably across connections.** Measured in the first real runs:
  `/json/list` returned window2 before window1, and Playwright's own page order
  differed between two `connectAll` calls on the same live host. Everything that
  needs to name a window therefore goes through `Target.getTargetInfo` on the page's
  own session plus the ids recorded in `dual-window.json`; positions are a fallback
  only. Do not reintroduce positional matching against either list.
- **CDP keystroke vs SendKeys.** The keystroke is sent through CDP to window1's
  page, which is the honest "inside the running instance" path. The first press can
  be swallowed (measured: attempt 1 produced no window, attempt 2 did), so it is
  retried up to three times, each after `bringToFront()`. `--system-keystroke` adds
  `activate.ps1 -Keys '^+n'` as a final attempt, but with two dev-host windows open
  that helper resolves the dev host by `MainWindowHandle` (one window per process,
  `src/win/devhost.ps1`) and can therefore raise the _wrong_ window — focus window1
  by hand before relying on it.
- **Which extension host belongs to which window comes from the log, not the process
  table.** Measured on this build: the extension host is
  `--type=utility --utility-sub-type=node.mojom.NodeService`, one of **six** such
  processes with no `--logsPath`, no `--user-data-dir` and no other per-window
  marker — so nothing in the command line can pair them. The pairing is each
  window's `exthost/exthost.log` pid; the older `--type=extensionHost` shape is still
  recognised, and only when no log pids exist does the mode fall back to creation
  order. Read `dual kill <n> --print-command` before a destructive run.
- **Force-killing the extension host kills that window, not just its host.**
  Measured: `Stop-Process -Force` on window2's exthost left window1 and the app
  running, and window2 closed (its CDP page target disappeared). That is still the
  crash shape the lease must survive — the point is that one window goes away without
  running `deactivate()`, so its lease file stays behind with a dead pid in it, which
  the survivor reads as immediately stale on its next tick (`§11.2`) rather than
  waiting out the 35 s expiry — but do
  not expect the victim window to keep showing an inert UI, and use a palette reload
  (step 7) when you want the window to come back. `pnpm kill` (everything) and
  `dual close` are the orderly paths.
- **Two dev hosts at once break the process filters.** `kill.ts`, the window
  helpers and this mode all match Code.exe by _this directory_ in the command line,
  not by pid, so a second dev host started from the same harness makes the pairing
  ambiguous. Kill extras first.
- **The state file pins the session; `logs` and `targets` are the two commands that
  look past it.** `dual windows`, `dual verify`, `dual kill` and `dual state` call
  `requireState` and **fail** when `dual-window.json` is missing ("run 'dual launch'
  first") — deliberately, since each is a statement about _the_ session this mode
  launched, and the newest session on disk may belong to a completely different host.
  Two commands tolerate the missing file instead, both via `readState`: `dual targets`
  (it also prints a note that nothing is recorded) and `dual logs`, which falls back to
  the newest session under `profile/logs/` — that fallback is what makes `dual logs`
  usable for a host started by plain `pnpm launch` (no state file at all). Know what
  each command tells you about the session it resolved: `dual windows` prints
  `session <name>` first, `dual verify` prints its `log dirs: <windowN, …>` line (no
  session name, and the state-file path above it), and `dual logs` prints
  **neither** — only the per-window `--- windowN …`
  headers. So check `dual targets`/`dual windows` or the state file itself before
  trusting a `dual logs` fallback.
- **`dual logs <n>` (one window) throws once that window has reloaded or been killed.** The
  label → directory mapping matches the extension-host pid recorded in `dual-window.json`
  against the **newest** `Extension host with pid <n> started` in each window's
  `exthost/exthost.log`, and nothing re-records that pid, so after a reload (new pid, new
  `output_logging_*` directory inside the same window directory) no directory matches and the
  command fails with `could not attribute a log directory to window2 (recorded exthost pid …)`.
  Measured 2026-09-28: window2's reload changed its exthost pid 44920 → 28532 and added
  `window2/exthost/output_logging_20260928T140210/`; `dual logs 2` threw from then on while
  `dual logs 1` kept working (window1's recorded pid was still the newest in its own log).
  `dual logs all` never consults the pids — it takes every `windowN` directory — so it is the
  one form that still resolves after a reload. To read one window's channel directly, take the
  newest `profile/logs/<session>/window<N>/exthost/output_logging_*/` and its
  `<n>-Forgejo Toolkit.log`; that is also where a handover's per-window timestamps come from.
- **Window2 starts from the first launch's arguments.** `--locale` (from
  `UI_LOCALE`), `--extensionDevelopmentPath` and the profile come from the launch,
  so the second window does localize and does load the extension — the mode checks
  the latter through its extension host. Anything per-window that the _first_ window
  had already stored (an opened folder's UI state, for instance) is fresh in
  window2, which is what a new window means. Measured: the window opened by
  `Ctrl+Shift+N` came up with the profile and the extension but **without** the
  workspace folder that `dual launch <workspace>` passed to window1 (its title was
  the plain `Forgejo Toolkit Setup`, window1's carried `- forgejo-toolkit`). That is
  fine for the lease and the logs — `globalStorage` is per profile, and both windows
  activate and log — but do not expect window1's opened folder to be there.

### What the first real run established (2026-09-27)

The mode was run end to end on this machine after the build. These are the four
questions that had to be answered by a real run, with the evidence that settled each
one (two separate sessions; the `globalStorage` files below are from the first):

| Question                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the in-instance keystroke really open a second window of the same profile? | **Yes.** Attempt 1 over CDP produced nothing, attempt 2 opened it (the same 1-then-2 sequence repeated in a later session); the second window loaded the extension — its own `Extension host with pid <n> started` and `ExtensionService#_doActivateExtension cpf23333.forgejo-toolkit` line in `window2/exthost/exthost.log`.                                                                                                                                                                                       |
| Do both windows share one `--user-data-dir`?                                    | **Yes.** `dual verify`'s profile check passed, and the shared directory shows it: `profile/User/globalStorage/cpf23333.forgejo-toolkit/` holds `mcp-workspace-23284-….json` (window1's extension host) and `mcp-workspace-11988-….json` (window2's) written 24 s apart, while the workspace-folder `workspaceStorage` entry for `d:\code\forgejo-toolkit` stayed single (`72e030fad9fd…`) — per-window data differs, the profile's `globalStorage` is one directory. That is exactly the shape the lease file needs. |
| Can a window be paired to its extension host?                                   | **Yes, through the log.** Both windows' `exthost.log` pids resolved to live NodeService processes, and `dual verify` printed one live extension host per window; `dual targets` lists each window's recorded id next to its title. Killing window2's host hit nothing else (window1's pid stayed alive, and `Stop-Process` only ran after the pid was re-checked against the process table).                                                                                                                         |
| Does per-window log capture see both windows?                                   | **Yes.** `dual logs all` printed each window's own channel: `output_logging_20260927T192636/1-Forgejo Toolkit.log` for window1 and `output_logging_20260927T192700/1-Forgejo Toolkit.log` for window2, each with its own `Mock API server started` + `Forgejo Toolkit extension activated` pair — distinct directories, distinct timestamps, distinct pids.                                                                                                                                                          |

What the run also changed, beyond the three defects it found (a `/json/list` field
named `id` that made every target id `undefined`, an extension host that is a
`node.mojom.NodeService` utility process rather than `--type=extensionHost`, and a
failed launch that left two orphan windows with no session file): `/json/list` and
Playwright's own page order are both unreliable for labelling windows, so targeting
now goes through each page's CDP session plus the recorded ids; the first
`Ctrl+Shift+N` can be swallowed, so the chord is retried; and `dual launch` records
the session as soon as window1 exists, so a failure never leaves orphans.

### Still unproven

- **The MCP broker handover inside the two windows.** The broker line
  (`MCP broker listening at \\.\pipe\forgejo-toolkit-mcp-<hash>`) was in neither
  channel of this run: no MCP client connected, and the endpoint is derived from the
  user profile rather than `--user-data-dir`, so with the user's own VS Code running
  the dev host would step aside by design. Verifying it needs `USERPROFILE`/`HOME`
  redirected before the launch (see "Broker verification needs its own home
  directory" in **Known blind spots**).
- **The lease's own soak numbers.** Stage 2 ships the lease and its `§7.1` lines
  (`forgejoToolkit.multiWindowLease`, default on), so "which window is leader" and
  "how long the handover took" are readable today, not reviewed against the design.
  What is still unproven is the calibration: the one-week shadow log for H/N/K, and
  per-window focus fidelity — the stage-1 soak saw both windows of one instance
  report `focused=true` with no `focus-lost` at all, so "the prompts follow your
  focus" is intent, not a measured property, on this platform.
- **Window identity beyond the launch.** A window is named by the CDP target id
  recorded at launch; that id is not guaranteed to change on a reload, and the recorded
  extension-host pid does. Measured 2026-09-28: `Developer: Reload Window` in window2 left its
  CDP target id unchanged (`96AB1A60…` before and after), so do not assume the id either
  survives or changes — what certainly does change is its exthost pid and its
  `output_logging_*` directory, which is why `dual logs 2` failed afterwards (see the traps
  above). A window that reloaded or was closed and reopened by hand is therefore not reliably
  recognisable as "window2" — the mode still refuses when the page count changes around its
  own launch, which is the case that matters for the two-window invariant.
- **The `window<N>` directory names.** The mapping is by log pid, but on a session
  whose window numbers do not start at 1 the _fallback_ (VS Code numbering) is what
  attributes the directories before the pids are read; that fallback is unexercised
  on a fresh profile, where the two lowest numbers happened to be `window1`/`window2`.
  Everything pure is covered by
  `pnpm --filter @cpf23333-forgejo-toolkit/ui-review test` (window addressing,
  log-directory resolution, keystroke and command construction, kill-target
  selection).

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

`dialog.ps1` refuses to guess which dialog to talk to: add `-Title '<regex>'` when
more than one `#32770` is visible, and it also refuses when the only candidate is
owned by another process or cannot be brought to the foreground, instead of
sending keys to whatever it found first. It also reports whether the keys landed:
its last line is a summary (`summary: sent {ENTER} to dialog 'Delete this'
(dialogClosed=true)`) and it exits non-zero when the dialog is still open
afterwards, so a checklist run cannot read a modal that swallowed the keys as
success. `fileDialog.ps1 -Cancel` dismisses the
file picker with Escape (falling back to `WM_CLOSE`, which it reports) and never
touches the file row; without `-Cancel` the script clicks `-RowIndex` (optionally
at the `-RowY` you read off a capture) to accept the dialog.

Both helpers locate the dev-host window by the isolated `--user-data-dir` of this
harness (`src/win/devhost.ps1`), not by window title, so they also work with a
localized UI (e.g. `UI_LOCALE=zh-cn`, where the title is `[扩展开发宿主] …`).

## Runtime state

`profile/` (persisted dev-host settings), `extensions/` and `shots/` are gitignored. The
launcher pre-seeds `forgejoToolkit.useMockApi: true`, but **that setting alone does not give
you mock data**: `packages/forgejo-toolkit/src/extension.ts` starts the mock server only when
`process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS === 'true'`, and `packages/forgejo-toolkit/esbuild.js`
_defines_ that expression at build time — `'true'` for a non-production build
(`pnpm --filter forgejo-toolkit build:extension`), `'false'` for a production build, which
dead-code-eliminates `src/test/mocks/` (msw and its fixtures) entirely. The launcher writes the
setting and never controls that flag, so **against a production `out/` the dev host talks to
whatever instance the shared profile has configured**. Measured 2026-09-28: a production-shaped
build (no `Mock API server started` line in the output channel) polled the profile's real
instance for a whole session. **Since 2026-09-28 the launcher detects this before it starts
anything**: it reads `packages/forgejo-toolkit/out` for mock-only markers and refuses the launch
when the build has no mock API compiled in, unless `--real-api` says the real instance is wanted
(the exact message, the markers and the opt-in are in "Mock-backed runs and the real-API opt-in"
above). Treat a harness run as able to touch a real server: the polling
here is read-only, but the instance-wide actions under "Some UI actions are instance-wide"
below apply unchanged, and `--real-api` is what turns that possibility into a stated intent.
Rebuild without `--production` (the checklist's mock-backed walkthrough
recipe) when you want the MSW handlers.

## Release walkthrough checklist

Rebuild first — the dev host loads `out/`, so a walkthrough against a stale build
verifies the wrong code. **The rebuild is the maintainer's step** (`AGENTS.md`
forbids the agent from running build commands), so ask for it and then check the
build time rather than running it yourself. Which build matters:

- **mock-backed walkthroughs** (everything below except the push-target and MCP
  items): `pnpm --filter forgejo-toolkit build:extension`, i.e. esbuild _without_
  `--production`. The production build strips `src/test/mocks/`
  (`FORGEJO_TOOLKIT_INCLUDE_MOCKS=false`), so with it the Dashboard lists no
  repositories and every request goes to the real network.
- **production-shaped walkthroughs** (install the packaged `.vsix` instead):
  `pnpm --filter forgejo-toolkit build`, and point an instance at a real server.

Then run through the flows below; each one covers behaviour that unit tests
cannot observe (native modals, real git, real MCP clients). Numbers a walkthrough
produces (bundle size, render cost, activation time and the like) are recorded in
the commit that made the change and in that change's `CHANGELOG` entry, not in
`FEATURES.md`'s delivered list; a design document keeps only the measurements that
drove one of its decisions.

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
   "Delete attachment #10 of release #5 in <instance name> (demo-user/demo-repo)?"
   (`确定删除 <实例名> (demo-user/demo-repo) 中版本 #5 的附件 #10 吗？`), the
   instance-scoped form of "Delete attachment #{0} of release #{1} in {2}?" — the
   ids come from the fixtures and `{2}` is the instance name plus `owner/repo`, so
   there is no generic "delete this attachment?" prompt any more. `{ESC}` keeps
   the row, `{ENTER}` removes it and the debug log shows
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

Two harness limits worth knowing before planning a flow:

- **The file picker (`showOpenDialog`) needs real mouse input.** It is the modern
  Common Item Dialog, and almost nothing else works on it: window messages
  (`WM_COMMAND`/`IDOK`, `BM_CLICK`) are ignored, and neither the file-name box nor
  the buttons exist in its UI Automation subtree. Beware the classic `Edit` with
  control id 1148: it is a hidden legacy proxy — `SetWindowText` writes to it and
  reading it back confirms the text, while the box on screen stays empty, so Open
  reports "file not found" and it looks like the dialog accepted the path.
  `dialog.ps1`'s SendKeys _can_ land once the dialog has been activated, but two
  traps remain: the last character of a typed path can be dropped (seen with
  `.json` arriving as `.jso`, which the dialog only reports as "file not found"),
  and `PrintWindow` may render the DirectUI file-name box empty even when it holds
  text — so never judge the typed value from a capture; read it back from the
  proxy control with `GetWindowText`. A path the picker rejects leaves the dialog
  open, which `dialog.ps1` reports as `dialogClosed=false` and a non-zero exit.
  What works reliably (`src/win/fileDialog.ps1`): flash the dialog TOPMOST and
  attach to the foreground thread so it can be activated, then click and
  double-click the file's row. Two consequences: the file must be in the folder
  the dialog already shows, and the row position has to be read from a capture —
  `src/win/shot.ps1 -Dialog` prints the geometry and saves a PNG of the
  `PrintWindow` render, which is the most reliable way to see this dialog's state.
  Only when `PrintWindow` fails does the script fall back to grabbing the screen
  area, and it says so in its summary line (`screenFallback=true`) so a capture
  that might show another window is never mistaken for the dialog's own render.
  Leftover dialogs are closed with `WM_CLOSE` on the dialog the caller selected.
- **Some UI actions are instance-wide.** "Mark all notifications read" sends its
  `PUT …/notifications?all=true` to _every_ configured instance. If the profile
  also holds a real instance (e.g. because a walkthrough needed one), that action
  changes real data. Prefer mock-only instances while walking bulk or destructive
  flows and remove a real instance again once the flow needing it is done.
- **Editor-area panels can take the driver's input.** The setup wizard is an
  editor-area `WebviewPanel`, and on the tested build the CDP driver drove it end to
  end: it clicked through the language step, typed the server address and token into
  its fields, pressed Test Connection and Add Instance, and added two instances. So a
  flow that lives only in a panel — instance removal, for instance, is only in the
  setup wizard — is worth attempting instead of assumed impossible. That is what the
  driver managed on that panel, not a guarantee for every panel: a panel you have not
  driven before still needs a `shot` after the first click before you plan a flow
  around it.
- **`src/mcpCheck.mjs` runs the MCP server headless.** It spawns
  `out/mcp-server.mjs` with an instance URL/token read from an instances export and
  drives it over stdio JSON-RPC, which is how the checklist's MCP items are
  covered without agent mode: tool surface, hostile-input validation and the
  truncation marker on large results. The token is never printed. It sets
  `FORGEJO_MCP_INSTANCE_URL`/`FORGEJO_MCP_TOKEN` but leaves
  `FORGEJO_MCP_BROKER_ONLY` unset, so it only exercises the **direct-launch**
  mode when **no broker registration is discoverable**: the server now tries the
  extension-host broker first for every launch, and with a broker running (the
  extension active for this user profile) it forwards into the host instead and
  the harness's own token is unused. To force the direct-launch path — and to
  check the broker deliberately — point `FORGEJO_MCP_DATA_DIR` at a directory
  with no `mcp-broker.json`, or drop the instance variables and let it forward.
- **Verifying what VS Code's own MCP client does needs a signed-in profile.** An
  Agents window reads and _lists_ a user-level `mcp.json` server even when signed
  out (the MCP Servers page shows it installed and enabled, and the gateway
  creates a `mcpServer.mcp.config.usrlocal.<name>.log` sink beside the window's
  other logs), but no MCP server is started until the profile is signed in and a
  session exists — `New Session` and the card's `Start Server` are no-ops behind
  the "Sign in to use Agents" modal and every sink stays empty. Watch that sink
  for the shim's own lines — `forwarding to the extension-host broker at
\\.\pipe\forgejo-toolkit-mcp-<hash>` (authenticated through a running window) or
  `auto-matched instance …` / `FORGEJO_MCP_TOKEN is not set; reading anonymously`
  (degraded) — and the extension's log for the matching `MCP broker: session …`
  line.
- **Broker verification needs its own home directory.** The broker endpoint is
  derived from the _user_ profile (`sha256(username + homedir)`), not from
  `--user-data-dir`, so an isolated dev host started next to a running real VS Code
  finds the pipe already owned and **steps aside silently by design** (the
  extension stays healthy, and a check that just looks for "no error" would pass
  while proving nothing). Redirect `USERPROFILE`/`HOME` when launching the harness
  if the broker path is what you are verifying, and confirm the dev host bound its
  own `\\.\pipe\forgejo-toolkit-mcp-<hash>` before drawing conclusions. With a
  custom `--user-data-dir`, also set `FORGEJO_MCP_DATA_DIR` for the launcher, since
  instance discovery only scans the standard `%APPDATA%\Code\User[…]/profiles\*`
  layout. The stable-path shim lives in the profile's
  `globalStorage/cpf23333.forgejo-toolkit/mcp-server.js`; running it with `node`
  and getting `ERR_UNSUPPORTED_ESM_URL_SCHEME` means the shim's specifier is a
  path rather than a `file://` URL (a Windows-only failure a text-only assertion
  cannot catch).
