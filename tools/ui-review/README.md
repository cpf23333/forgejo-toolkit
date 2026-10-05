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
- **Both halves of the extension have to be rebuilt, and they are two commands.**
  The host bundle is compiled by Rolldown (`rolldown.config.mjs`) and the webview
  assets by Vite (`webview/vite.config.mts`); `build:extension` runs only the
  first, so after it the webview under `out/webview` is whatever was there before
  (the repository carries a checked-in one — a stale webview is the default, not
  an accident). The settings page lives in the webview, so against a host-only
  rebuild it renders the old UI with no AI section at all and the walkthrough's
  own settings step is unreachable. Rebuild both:

  ```bash
  pnpm --filter forgejo-toolkit build:extension   # host: out/extension.mjs + chunks (Rolldown)
  pnpm --filter forgejo-toolkit build:webview     # webview: out/webview/** (Vite)
  ```

  `pnpm --filter forgejo-toolkit build` runs both, in the same order, but adds
  the production flag — it strips the mock API, so use it only for a
  production-shaped walkthrough (see "Release walkthrough checklist" below).
  Check the build time of `out/extension.mjs` **and** of `out/webview/index.html`
  rather than trusting one of them: a host-only rebuild leaves the webview's
  timestamp old, which is exactly the state this note is about.

- **For the local AI endpoint** (`--ai-mock`, see "The local AI endpoint" below) the
  build also has to contain the OpenAI-compatible transport _and_ its wiring into
  the AI pre-review. The harness can start that endpoint and point the profile at
  it, but it cannot put the transport into a build that predates it: against such a
  build the settings page has no AI section and no request can reach the endpoint.
- The build has to be **mock-backed** for a launch without `--real-api`: the
  launcher reads `packages/forgejo-toolkit/out` and refuses to start a window
  when the mock API is not compiled into it (see "Mock-backed runs and the
  real-API opt-in" below). It also refuses when the profile's own instances are
  not ones the mock handlers can serve (an `http://` instance is, a URL with a
  path prefix is not), so a mock-backed run either polls the fixtures or stops
  with a message.
- No Playwright browser download needed; only `connectOverCDP` is used.

## Commands

These scripts live in `tools/ui-review/package.json`, not in the root manifest, so
they have to be selected with `--filter` from the repository root (or run from the
harness directory). `pnpm launch` at the root fails with
`Command "launch" not found`.

```bash
# From the repository root:
pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch [workspacePath] [--real-api] [--ai-mock] [--ai-mock-port N]  # start dev host (default workspace: D:\code\test)
pnpm --filter @cpf23333-forgejo-toolkit/ui-review kill                   # stop only the isolated dev host instance (and the AI mock endpoint)

pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock serve          # the local OpenAI-compatible endpoint, in this terminal
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock url            # the running endpoint's URL
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock requests       # what the endpoint has seen
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock stop           # stop the endpoint only

pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui shot <name>  # CDP screenshot -> shots/<name>.png
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui scale [name]  # devicePixelRatio + viewport, against the last reading
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui frames [x y] [name]  # the coordinate space, every open webview frame, and which one holds (x, y)
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui click <x> <y> [name] [waitMs]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui rclick <x> <y> [name] [waitMs]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui scroll <x> <y> <deltaY> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui drag <x1> <y1> <x2> <y2> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui hover <x> <y> [name]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui type <text> [name]  # types into the focused element; quote the text
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui key <key> [name]    # e.g. Escape, Enter, Tab
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui eval --script-file <path.js> [name]  # evaluates in the workbench page, prints the result

# Equivalent, from the harness directory (the `src/...` paths below assume it):
cd tools/ui-review
pnpm launch [workspacePath] [--real-api] [--ai-mock]
pnpm kill
pnpm ai-mock requests
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

Coordinates are read off the previous CDP screenshot: one image pixel is one CSS
pixel, which is the space CDP input uses. Measured 2026-10-05 in the isolated dev
host: viewport 1440x900, `devicePixelRatio` 1, `visualViewport.scale` 1, no `zoom`
or `transform` on `html`, `body` or `.monaco-workbench`, and a `shot` that came back
at exactly 1440x900 image px. `shot` prints that reading back
(`1440x900 image px at devicePixelRatio 1 (1.00 image px per CSS px); webview
frames: …`), so the space is a measurement rather than an assumption.

**A webview is a separate frame, and several can be open at once.** The extension's
sidebar view (the dashboard and the settings page) and an editor-area webview panel
(the first-run setup guide, a pull-request panel, …) are two `iframe.webview` frames
with their own rects — and **`document.querySelector('iframe.webview')` answers with
the first one only**, the sidebar's. Measured 2026-10-05 with both open: sidebar
`(49,68) 233x794`, editor panel `(289,69) 425x502`. An earlier run measured the
sidebar frame (`297x794` in its wider window), compared it with an ~890 px wide
editor-area panel, read the two as a 3× mismatch of "the frame", and scaled its
coordinates to match: the clicks then landed on the wrong element. There was no
scale mismatch at all — the two numbers were two different frames, and 890/297 ≈ 3
was a coincidence of the sidebar's width and the editor area's.

A coordinate therefore belongs to whichever frame's rect contains it, and the
procedure is only complete with the frame named:

- `ui frames` prints the coordinate space (`viewport`, `devicePixelRatio`), the
  capture the coordinates are meant to come from (its image size, its image px per
  CSS px, the frames it recorded), the frames open **now**, and — given `x y` —
  which frame contains that point.
- Every pointer command prints the frame its coordinate lands in before it acts:
  `click: (110, 381) is inside the sidebar webview (49,68) 233x794, webview ad61c2c5`,
  or `click: (242, 48) is over workbench chrome (no webview frame contains it)`.
- A control inside a webview is addressed as the host frame's offset plus the
  control's position inside the guest (`pageOffset` above), and a control the guest
  has scrolled out of view is not clickable at all: scroll it first (`ui scroll`
  with the pointer over the frame), then take a fresh screenshot.
- The guest DOM is reachable from a script that connects over CDP itself (measured;
  see **Known blind spots**), which is how a click is _proved_ to have reached the
  intended control instead of a neighbour — click the coordinate, then read the
  guest's own state.

**A panel can be painted over a webview frame, and the frame guard cannot see it.**
Measured 2026-10-05 in the isolated dev host: the settings editor that
`forgejoToolkit.openNativeSettings` opens is an editor-area panel whose
`document.querySelector('.settings-editor')` rect was `(145,138) 1150x657` while the
sidebar frame was `(49,64) 297x794` — the panel is drawn over the sidebar's own rect
from x 145 rightwards, and it is **not** a webview frame, so `placeCoordinate` still
answers "inside the sidebar webview". The click is then delivered to the panel and
the sidebar control underneath never sees it, silently: `ui click` exits 0, and the
frame guard has nothing to refuse on because its question ("which webview frame
contains this point?") is answered correctly. Measured in the same session: the
coordinate `(300,193)`, aimed at the `ai-local-only` checkbox label, left the
checkbox `false` with the panel open and set it to `true` at the very same
coordinate once `Escape` had closed the panel. Two habits answer it:

- **Know what is on top before aiming at the sidebar.** Close the panel you opened
  (`Escape` closes the settings editor) or take a fresh `shot` and check that nothing
  floats over the frame you are aiming into; the overlay is visible in the capture
  and invisible to every guard the harness has.
- **Do not read an early DOM query as "the click did nothing".** The same panel
  answered `.settings-editor` count `0` in a read taken right after the click and
  `1` two seconds later: a panel that has not painted yet looks exactly like a click
  that missed, so confirm a _negative_ result by re-reading, not once.

**A `vscode-textfield` is cleared through the same one-step-per-invocation recipe,
read back from the guest.** An earlier run saw one `Ctrl+A`+`Delete` leave a stale
character in such a field (the screenshot then disagrees with the value the page
would submit), which a screenshot cannot settle either way; it did not reproduce on
2026-10-05, and the recipe that did hold is the one the `ui eval` section already
gives — `click` → `key Control+a` → `key Delete` → `type`, one command per
invocation — followed by a **readback inside the guest** rather than a look at the
capture: the field's own `value` property and, because the component is a custom
element, `field.shadowRoot.querySelector('input').value`. Measured with that
sequence: both read `""` after the `Delete` and the full new text after the `type`.
Treat a stale character the moment the two disagree.

**The pixel scale can move under you, and a coordinate read off an older
screenshot then points somewhere else.** Measured 2026-10-05: `devicePixelRatio`
in the dev host went 1 → 1.5 mid-session; a screenshot is in device pixels while
CDP input is in CSS pixels, so every coordinate taken from the earlier capture
landed elsewhere and the clicks missed — silently, since a click that hits nothing
still exits 0. Two things answer it:

- **Automatic guard.** Every pointer command (`click`, `rclick`, `scroll`, `drag`,
  `hover`) refuses on the recorded numbers — naming both sides of the disagreement —
  when the coordinate cannot be trusted:
  - the page's `devicePixelRatio` moved since the last reading (the message below);
  - the coordinate is **outside the page's CSS viewport**: measured, the settings
    page's `AI 端点` section sat at inner y≈1460 of the 794-high sidebar frame, so a
    coordinate taken from that element resolved to y≈1528 of a 900-high page, where
    the click reached nothing and still exited 0;
  - **the capture and the page disagree about what a pixel is**: the capture's
    `image.width / viewport.width` is not the page's `devicePixelRatio` (a stale
    capture from another window size, a build that captures at device scale, an
    unexpected zoom). This is the honest form of a "the frame is 3× bigger than the
    screenshot says" report: it names the capture's image size, its image px per CSS
    px and the page's device px per CSS px;
  - **the frame that contained the coordinate at capture time** has moved, resized
    or closed since — the element the coordinate was read for may not be there any
    more.
- **On demand.** `ui scale` prints the current `devicePixelRatio`, the viewport and
  the scale the last reading recorded, so a screenshot that looks "zoomed" can be
  confirmed rather than guessed at; `ui frames` adds the frames on both sides.

The guard never rescales and never guesses: only a fresh `shot` makes coordinates
truthful again.

```
ui click: the page's pixel scale changed from 1 to 1.5 since the last reading (2026-10-05T…).
  A screenshot is in device pixels and CDP input is in CSS pixels, so a coordinate read off the older capture
  no longer points at the same place and the click would miss.
  Take a fresh screenshot (viewport 1440x900) and read the coordinates off that. Nothing was clicked.
```

`ui type` takes one text argument and an optional screenshot name, so a third token
means the shell split the text: the command refuses it and prints the tokens instead
of typing the first word and reporting success.

### `ui eval`: pass the script as a file, not as an argument

A script argument has to survive the shell `pnpm run` uses before `tsx` ever sees
it, and an **arrow function is where that goes wrong**: the unquoted `=>` is read
as a redirection rather than as part of the script. Reproduced 2026-10-05 by
forwarding the command line straight through `cmd.exe` to a throwaway script that
dumps `process.argv`:

| what was typed       | what the CLI received                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `"() => 1"` (quoted) | `["() => 1"]` — intact                                                 |
| `() => 1` (unquoted) | `["()", "="]` — split, and the redirect target is at the shell's mercy |
| `"() => 1" name`     | `["() => 1", "name"]`                                                  |

Two consequences. The quoted, metacharacter-free form does work, and it is the only
argument form worth using. The unquoted form does not merely truncate the script —
the `=` that survives is whatever the shell did with the redirection, which is how a
report of this trap described stray files appearing in the repository root. `tsx`
never mangled anything; the damage happens before the process starts, so this is not
something the harness can fix from inside. `ui eval` now **refuses** a script that
arrives as several arguments (naming them) or empty, instead of evaluating the
fragment and exiting 0, and the reliable invocation is a file:

```powershell
# Write the script to a file first. A here-string keeps quotes and "=>" intact:
@'
() => document.querySelectorAll('.monaco-workbench').length
'@ | Set-Content shots\eval.js

pnpm --filter @cpf23333-forgejo-toolkit/ui-review ui eval --script-file shots\eval.js
```

`--script-file` carries a path, so no shell metacharacter from the script reaches
the command line. The single-argument form (`ui eval "…"`) still exists, but the
script must arrive as **one already-quoted argument** with no metacharacters the
shell would touch; if it arrives split or empty the command fails loudly and names
the file form instead of evaluating a fragment.

**A script file may be a function or a bare expression, and the function form is
run in the page for you.** The script's text goes to `page.evaluate`, which takes a
string as an _expression to evaluate_ — so the arrow-function form above is
**called** there, and its answer is then dropped: a function is not a serializable
value, so it does not cross the CDP boundary, and the call's result arrives as
`undefined`. Measured 2026-10-05 in the isolated dev host, which is what fixes the
shape of the repair:

| expression handed to `page.evaluate` | answer       |
| ------------------------------------ | ------------ |
| `() => 7`                            | `undefined`  |
| `typeof (() => 7)`                   | `"function"` |
| `(() => 7)()`                        | `7`          |
| `async () => { return 7; }`          | `undefined`  |
| `globalThis.f = () => 7; f`          | `undefined`  |

The table is read as one fact, not four: **an expression whose value is a function
answers `undefined`**, whatever its shape, and only a call of it answers a value. So
no wrapper on this side can recover anything — the function is already gone by the
time the command sees the answer, which is why the repair has to run _inside_ the
page. `ui eval` now evaluates an **IIFE** that runs the script once there and returns
what it produced (`src/evalScript.ts`), which is why the file form above answers with
the element count instead of `undefined`. Three consequences:

- **A bare expression still works unchanged** (`document.title`, `location.href`):
  it is not a function, so it is answered as its own value. Neither form is
  preferred; the function form is what the README's own example uses and what a
  script with statements in it needs (`() => { …; return x; }`).
- **A script that throws still throws its own error**, named as written: the wrapper
  tests `typeof` before calling, so a non-function script is never called and its
  `ReferenceError` is not replaced by one about the wrapper.
- **A script whose result is itself a function is refused, loudly and non-zero.**
  That result cannot be printed either, and it is indistinguishable from the script
  _being_ a function once both have run — so the page answers a marker the command
  turns into a named failure, instead of printing a function object or a second
  silent `undefined`. Write the script to return what you want to see
  (`() => document.title`), not a function factory.

Each `ui` invocation is its own CDP connection, so a `click` does not always take
focus before the `type` of the **next** invocation runs. Measured in one acceptance
run: the first click on a newly added form field silently swallowed all 27 typed
characters (the `shot` showed an empty field), while the same click+type on a fresh
form had worked. The pattern that held up is one step per invocation —
`click` → `key Control+a` → `key Delete` → `type` — checking each step's screenshot
(every command already writes one under `shots/`). A screenshot is the only
trustworthy check here: the command exits 0 whether or not the value landed, so
never read a bare success as "the field is filled".

### Traps this harness keeps re-learning

Four of these cost a walkthrough a working click each, all measured 2026-10-05 in
the isolated dev host:

- **Quote a `ui type` argument that contains a space.** `ui type` takes **one**
  text argument and an optional screenshot name, so a two-word argument arrives
  split through some shell paths: the command refuses it and prints the tokens
  instead of typing the first word and reporting success.
  `ui type "Add dark mode" create-title` is the working form;
  `ui type Add dark mode` is refused. (The refusal is deliberate — the alternative
  is a silent half-typed field — so read the error rather than retrying it the same
  way.)
- **A native modal blocks every input in the window, the harness's own clicks
  included.** A confirmation modal (a destructive host command's prompt, the
  pre-review's or the description's consent question) is a separate Win32 window:
  CDP input goes to the webview underneath it and nothing on the page reacts, so a
  click that "did nothing" may simply have been swallowed. Ask for a dialog
  **first**:
  `powershell -File src/win/shot.ps1 -Dialog` lists every visible `#32770` (with
  its rect) and saves a render of it. Answer or dismiss it, take a fresh screenshot,
  and only then judge the click. This is the concrete form of "editor-area panels
  can take the driver's input": a modal is the same class of invisible overlay, and
  `ui frames` cannot see it either.
- **A control can be inside its frame and still off-screen: scroll _inside the
  guest_ first.** The create-pull-request dialog is taller than the sidebar
  viewport, so its description field is below the visible area. `ui click` at that
  coordinate is delivered to whatever is painted there instead, exits 0, and the
  field is never focused — `ui frames` is satisfied because the frame does contain
  the point. Put the pointer over the frame and scroll it (`ui scroll <x> <y>
<deltaY>`), then take a fresh `shot` and read the control's position off **that**:
  a coordinate from before the scroll is a coordinate for the old layout.
- **`ui eval` evaluates in the workbench page only; webview page state needs the
  guest frame.** `ui eval --script-file …` runs in the top document, where the
  extension's own DOM does not exist (it is a `src`-less nested iframe). A check
  such as "the body field holds the draft" therefore has to read the guest: connect
  over CDP yourself, take the frame that is **not** the main frame (its `url()` can
  come back empty — see **Known blind spots**), and hand it a **static function
  body** (`frame.evaluate(() => { … })`). The guest's CSP has no `unsafe-eval`, so
  the body cannot be built at run time from a string, a template or a parameter: no
  `eval`, no `new Function`, and no "pass the selector in". The reader a walkthrough
  writes for exactly this lives under the gitignored `shots/` directory
  (`shots/guest-read.js` in the run of 2026-10-05: connect over `CDP_PORT`, pick the
  frame whose `#active-frame` exists, return the body field's own value and the
  control's own labels); **the recipe is what to reproduce, not the file** — it is
  gitignored and the next run may not have it. Two things that reader has to know:
  the body is an **EasyMDE/CodeMirror** field, so its value is
  `doc.querySelector('.easy-mde-editor .CodeMirror').CodeMirror.getValue()` (the
  rendered `.CodeMirror-line` text is the fallback for reading, never for writing),
  and the form's draft-ownership rule is **not** a DOM attribute: it is visible only
  through the control's own state — the button's label (`生成描述` when the press
  will draft, `生成中…` while a run is in flight, and the replace line once the body
  is the user's) and the `field-description` hint beside it. A programmatic
  `cm.setValue(…)` or `cm.undo()` does **not** count as the user's edit for that
  rule — measured 2026-10-05: after an `undo()` restored the draft byte for byte,
  the next press still showed the "your draft will be replaced" line, i.e. the form
  still treated the body as the user's. Drive the field with real input
  (`ui click` on the editor, then `ui type`) when the ownership flag is what the
  step is about.
- **A mock instance the launcher refuses to run with can sit in the profile, and
  `pnpm kill` does not remove it.** See "Pruning an instance the launcher refuses"
  below.

## Mock-backed runs and the real-API opt-in

The mock API (msw and the fixtures in
`packages/forgejo-toolkit/src/test/mocks/`) exists in a build only when that build
was made **without** production mode: `packages/forgejo-toolkit/rolldown.config.mjs`
_defines_ `process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS` at build time (`'true'`
without the production flag, `'false'` with it) and `src/extension.ts` guards its
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
             packages/forgejo-toolkit/rolldown.config.mjs
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
costs a message rather than a surprise request.

**A mock-capable build is not enough on its own: the handlers also have to match
what the profile configures.** Measured 2026-10-05: the handlers were registered
for `https://*/api/v1/…` while the isolated profile seeded `http://` instances, so
MSW matched nothing and the request fell to the unhandled path — which in a dev
host only warns and then **passes the request to the network**. The run printed
`Mock-backed run: mock API compiled in …` and then polled a real Forgejo server
(nine repositories, one of them in no fixture; `/notifications` answering `[]`
against a non-empty fixture list). Two changes answer it:

- every handler is registered for **any scheme** (`*://*/api/v1/…`, see
  `src/test/mocks/handlers.ts`), so an `http://` instance is intercepted exactly
  like an `https://` one;
- the launcher refuses a mock-backed run whose profile holds an instance the
  handlers cannot serve — today that means a URL with a path prefix
  (`https://host/forgejo`; the handlers only cover the origin root). The message
  names the instance and the reason, and `src/mockInterception.test.ts` drives the
  real mock server for both schemes and asserts that nothing reaches the network.

```
Refusing to launch: this dev host would poll a real server.

  build:     …\packages\forgejo-toolkit\out  (mock API compiled in)
             every handler in packages/forgejo-toolkit/src/test/mocks/handlers.ts matches <any scheme>://<any host>/api/v1/…
  profile:   …\tools\ui-review\profile
  instances: Behind a proxy <https://forgejo.example.com/forgejo>

Cannot mock this instance:
  Behind a proxy <https://forgejo.example.com/forgejo>
             its path is not the origin root the handlers match (they cover <any scheme>://<any host>/api/v1/…)

Two ways forward:
  --real-api   run against those instances anyway. This is the explicit opt-in;
               polling here is read-only, but instance-wide actions reach these servers
               (for example "mark all as read", which changes data on every configured instance)
  fix the profile, so every configured instance is one the mock API serves:
               an http(s) URL with no path prefix (the handlers cover the origin root only),
               or remove the instance from the profile for this run
```

`src/apiMode.ts` reads the API path out of the handler patterns themselves rather
than restating it, so a moved mock API fails a test instead of silently widening
what the gate accepts. Three rules complete the picture:

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

### The instances line: what it means and when it is printed

A mock-backed run prints one `instances:` line. It is printed **before anything is
created or spawned** (that is what makes the refusal free), and the only instance
source that exists at that moment is `mcp-instances.json` — the registry a _window_
rewrites at activation, eagerly, from the editor's own instance store
(`globalState`, a SQLite store this harness does not read). The line therefore
describes the last published registry, not necessarily what the run will poll:

```
  instances: 1 recorded in the profile's registry (…\mcp-instances.json), every one of them
             covered by the handlers (<any scheme>://<any host>/api/v1/…):
             demo-user@forgejo.example.com <https://forgejo.example.com>
```

- Every instance the gate checked is named, so "covered" is a statement about a
  list the reader can see rather than about the profile in general.
- With an **empty or absent registry** the line says
  `none recorded in the profile's registry yet` and spells out that this is "not
  seen yet", not "nothing to poll": the window polls the instances its own store
  holds and writes them into that file, and an instance the file does not name yet
  has not been checked against the handlers' path rule.
- Measured 2026-10-05: an `--ai-mock` launch printed the empty-registry form — the
  old wording claimed "a window that runs has nothing to poll until one is added" —
  and the window then polled the profile's seeded mock instance, which it wrote into
  the registry during activation. A reader of that line concluded the opposite of
  what the run did; that sentence is gone.
- The two other reports that name instances (`--real-api`'s warning and the
  refusals) use the same source and print it as "none recorded in this profile
  yet", which is a statement about the file rather than about the run.

## The local AI endpoint: a real socket, deliberately not MSW

The extension's second model transport (`docs/design/ai-model-transport.md`) sends
to an OpenAI-compatible endpoint the _user_ configures. The harness can serve one
itself, so that transport can be walked end to end with nothing but loopback:

```bash
pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch --ai-mock
```

`--ai-mock` starts `src/aiMockServer.ts` as a **detached child** bound to the
loopback address, on a port the OS picks (`--ai-mock-port <n>` pins it; a fixed
port is never the default, because a fixed one collides), waits for the child to
report the port it actually bound, writes the profile's AI settings for it, and
then launches the dev host. `dual launch --ai-mock` does the same for the
shared-profile mode. Nothing is edited by hand, and nothing credential-shaped is
written (both are shown in "What `--ai-mock` writes into the profile" below).

### Why this is not an MSW handler

The mock API (`src/test/mocks/`) is **in-process interception**: MSW patches the
fetch layer inside the extension host. It _could_ answer a request to the model
endpoint, and that is exactly why it must not — a handler there would prove that
MSW can fake an endpoint, not that this extension reaches a real HTTP server, over
a real socket, reading an event stream that arrives in pieces. §15 of the design
record asks for the socket for the same reason, so this endpoint is an
`http.Server` and nothing under `src/aiMock*` knows MSW exists.

The two modes coexist, measured (2026-10-05):

- **MSW forwards the model origin rather than intercepting it.** With the
  interceptor installed the way the extension installs it, a `fetch` to a loopback
  SSE endpoint answered HTTP 200 with the real `text/event-stream` body, delivered
  as **four separate body reads over 183 ms** (a server writing four chunks 60 ms
  apart — so not buffered), while MSW only printed
  `intercepted a request without a matching request handler`. That warning in the
  dev-host log is the confirmation that MSW is _not_ the thing answering.
- So `--ai-mock` does **not** need `--real-api`, and the Forgejo fixtures stay in
  place. The two switches are independent: `useMockApi` / `--real-api` decide where
  the _Forgejo_ traffic goes, `--ai-mock` decides whether a local _model_ endpoint
  exists.

Which mode to reach for:

| what you want to walk through                                | what to run                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| the plugin's Forgejo behaviour, against the offline fixtures | `launch` (mock API on by default)                                                                       |
| the direct model transport, entirely offline                 | `launch --ai-mock`                                                                                      |
| the direct model transport against a real local model server | configure the endpoint in the settings page (Ollama, LM Studio, …) — same code path, different base URL |
| both at once                                                 | `launch --ai-mock` (mock Forgejo), or `--real-api --ai-mock` (real Forgejo, local model endpoint)       |

### Starting, watching and stopping it

```bash
pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch --ai-mock [--ai-mock-port 43117]
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock url        # the endpoint's base URL
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock requests   # every request it has seen
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock stop       # stop it ('pnpm kill' does too)
pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock serve      # run it in this terminal instead
```

- The state file `ai-mock.json` and the request log `ai-mock.log` sit beside this
  README and are gitignored. `serve` (the detached child's own command, which is
  what `--ai-mock` spawns) overwrites the log on every start and writes one line
  per request into it; `ai-mock requests` asks the endpoint itself over HTTP for
  the same list, so it works after the launcher has exited.
- **One stop command stops everything, log included — once the endpoint is proven
  gone.** `pnpm kill` (and `dual close`) stop the endpoint as well as the dev host,
  and the stop clears `ai-mock.json` **and** removes `ai-mock.log` when nothing
  answers at the recorded URL any more and no live pid is claimed to be the
  endpoint. The run before this one left the log behind on every stop, so a later
  walkthrough's reading of it started next to the previous endpoint's lines — the
  removal only covers the two outcomes where the log is provably dead, and the
  message names the file it removed. The two cases where it cannot be proven are
  left untouched and say so: `foreign-pid` (a live pid the state file does not prove
  is the endpoint, so the log may be its evidence) and a URL that still answers
  after the kill. A foreground `ai-mock serve` keeps its log when it exits — it
  stops by signal and only forgets its own state file; the log is the record of
  what it served.
- **Stopping is guarded by identity, not by pid.** The recorded pid is killed only
  while the recorded URL still answers as this endpoint (`GET /__mock/requests`
  returning `"id": "ui-review-ai-mock"`); a record whose endpoint is gone but whose
  pid is still alive is reported as `foreign-pid` and left alone, because nothing
  proves that process is the endpoint.
- **A port collision is reported, not swallowed.** The child exits, the launcher
  prints the tail of `ai-mock.log` (`cannot bind 127.0.0.1:<port> … EADDRINUSE`) and
  stops before any dev host is started. `aiMockServer.test.ts` asserts the same
  rejection at the server level and `aiMockRun.test.ts` asserts the CLI path.
- A second `--ai-mock` launch **reuses** the endpoint that is already running
  (rather than orphaning it on a new port) and refuses when `--ai-mock-port` asks
  for a different one than the running endpoint holds.

### What `--ai-mock` writes into the profile

Into `profile/User/settings.json`, as the settings the extension itself reads:

```jsonc
{
  "forgejoToolkit.aiProviders": [
    {
      "id": "ui-review-mock",
      "name": "Local mock endpoint (tools/ui-review)",
      "baseUrl": "http://127.0.0.1:<port>/v1", // the port the endpoint actually bound
      "models": [{ "id": "mock-pre-review", "name": "Mock pre-review model" }],
      "auth": "none",
      "headers": [],
      "localOnly": true,
    },
  ],
  "forgejoToolkit.aiProvidersEnabled": true,
  "forgejoToolkit.aiTransport": "openai-compatible",
  "forgejoToolkit.aiPreReview": true,
  "forgejoToolkit.aiModelBindings": [
    { "feature": "aiPreReview", "providerId": "ui-review-mock", "modelId": "mock-pre-review" },
    { "feature": "prDescription", "providerId": "ui-review-mock", "modelId": "mock-pre-review" },
  ],
}
```

- **One binding per AI feature the extension declares, not just the pre-review.**
  The list is read out of `packages/forgejo-toolkit/src/ai/modelSettings.ts`
  (`AI_FEATURES`) rather than restated here, because a feature with no binding
  cannot reach the endpoint at all: measured 2026-10-05, a walkthrough of the
  create-pull-request description had to add `prDescription` to this array by hand
  — the seed wrote `aiPreReview` only, since that was the only feature when the
  seed was written. A feature the source declares and this array does not is a
  failing test in `src/config.test.ts`, and the extension's
  `src/__tests__/aiModelSettings.test.ts` pins the same list from the other side.
- **Only the harness's own entries are touched.** Another provider (a real endpoint
  you added) survives, and a binding that names one **keeps it** — a binding you
  configured is never overwritten, not even for `aiPreReview` (whose entry used to
  be replaced unconditionally). A feature with no binding gets one, and a binding
  that already names `ui-review-mock` is refreshed in place, which is what makes a
  second `--ai-mock` launch follow the **new** port instead of the previous
  session's. Seeding twice duplicates nothing — `src/config.test.ts` pins all of it.
- **No key is written, anywhere.** `auth: "none"` is not a placeholder: the
  endpoint needs no authentication, so there is nothing to seed. A provider's key
  can only live in the editor's `SecretStorage`, which is not a file this harness
  may write, and writing a credential into a repository file is forbidden outright.
  If you want to exercise the credential path anyway, open the endpoint in the
  settings page and type the obvious dummy `sk-mock-placeholder` into its key
  field: that goes to the secret storage (never into a file), and the mock endpoint
  accepts any credential and never looks at it.
- `forgejoToolkit.aiPreReviewPromptScope` and
  `forgejoToolkit.prDescriptionPromptScope` are deliberately **not** written: both
  default to `ask`, which _is_ the consent question, and that is the one step a
  human performs.
- `localOnly: true` is true of this endpoint (it binds loopback only) and also
  exercises the provider half of the local-only policy.

### Pruning an instance the launcher refuses

The profile can hold a **forgejo instance the mock handlers cannot serve** — an
`https://` address, or any URL with a path prefix — and every mock-backed launch is
then refused before anything is spawned, with the instance named:

```
Refusing to launch: this dev host would poll a real server.

  build:     …\packages\forgejo-toolkit\out  (mock API compiled in)
  profile:   …\tools\ui-review\profile
  instances: Behind a proxy <https://forgejo.example.com/forgejo>

Cannot mock this instance:
  Behind a proxy <https://forgejo.example.com/forgejo>
             its path is not the origin root the handlers match (they cover <any scheme>://<any host>/api/v1/…)
```

`--real-api` is the opt-in that runs against it anyway (and then polls it for
real — see "Mock-backed runs and the real-API opt-in"). To get a mock-backed run
back, **remove the instance** — and note that editing the registry file alone is
not a fix, measured 2026-10-05:

- **Editing `mcp-instances.json` gets one launch through and comes straight
  back.** That file is a **mirror**: the window rewrites it at activation from the
  editor's own instance store. Measured: a registry pruned by hand let the next
  launch start (the gate reads the file _before_ the window exists) and the window
  then republished both instances into it, so the launch after that was refused
  again with the same message. Pruning the file is a way to _reach_ a window, not a
  repair.
- **The instance lives in the profile's global state, and that is what has to
  change.** For the isolated profile that is
  `profile/User/globalStorage/state.vscdb`, a SQLite database whose `ItemTable`
  holds one row per extension (`key = 'cpf23333.forgejo-toolkit'`) with
  `forgejoToolkit.instances` inside it. Removing the instance there — and its entry
  in `forgejoToolkit.seenNotificationIds`, which names instances too — is what makes
  the removal survive the next window. **Back the file up first**, stop the dev host
  before editing it (`pnpm kill`; a running window rewrites the store), and leave
  `forgejoToolkit.instanceToken.<id>` alone: that row is a **credential** in the
  profile's encrypted secret storage, and this harness never writes one. Measured
  after the edit: the dashboard listed one instance and the next launch's
  `instances:` line named only that one.
- **In a running dev host the ordinary path is the UI** — the Dashboard's instance
  list, or the setup wizard, which is where removal is offered. Prefer it when a
  window will start; it writes the store itself.

`pnpm kill` does not prune anything: it stops the dev host and the endpoint and
leaves `profile/` exactly as the run left it, so a bad instance survives every stop
until it is removed as above.

### What the endpoint answers

| route                    | answer                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /chat/completions` | SSE by default: openai-shaped `chat.completion.chunk` events ~60 ms apart (seven of them for the default answer), one deliberately unparseable `data:` line, a `finish_reason` chunk, and `data: [DONE]`. Without `stream: true` in the body (or with `?scenario=json`) it answers one `chat.completion` document instead |
| `GET /models`            | `{"object":"list","data":[…]}` with two models                                                                                                                                                                                                                                                                            |
| `GET /__mock/requests`   | everything it has seen (`ai-mock requests` prints it)                                                                                                                                                                                                                                                                     |

Every route also answers under a `/v1` prefix, because the seeded base URL carries
one while a bare base URL is the mistake the transport has to report.

The default answer is the AI pre-review's contracted JSON with **one comment
anchored to the offline fixtures' pull request** (`src/index.ts`, new-file line 2
of `mockPullRequestDiff`), so a run against the mock Forgejo produces a genuine
draft comment rather than one the validator drops for an unusable anchor.

Scenarios, as `?scenario=<name>` in the base URL or the `x-ai-mock-scenario`
header:

| name                          | what it answers                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `stream` (default)            | the streamed answer above, including the one skipped `data:` line                                       |
| `clean-stream`                | the same answer without that line                                                                       |
| `json`                        | a non-streaming document even though the request asked for a stream (§6.4 item 7)                       |
| `reasoning`                   | `delta.reasoning_content` prose beside the `delta.content` answer (two candidate streams, never joined) |
| `truncated`                   | a partial answer ending in `finish_reason: "length"`                                                    |
| `stall`                       | one chunk and then silence for 60 s — the idle-watchdog walkthrough                                     |
| `401` `403` `429` `500` `503` | that status with a JSON error body, on every route                                                      |

The transport keeps a base URL's query string, so appending `?scenario=429` to the
endpoint's address **in the settings page** makes every request to it take that
path — no code change, and the Test button then reports the 429 sentence. An
unknown scenario name is answered with 400 and the list of known ones.

### Walkthrough: endpoint → test connection → pre-review → destination

**Rebuild first — it is the maintainer's step, and it is two builds.** The dev host
loads `packages/forgejo-toolkit/out`, and a build that predates the transport (or
its wiring into the AI pre-review) makes every step below unreachable: the
settings page has no AI section, and the pre-review still asks the editor's own
models. **The settings page is webview code**, so a host-only rebuild is not
enough either: `build:extension` leaves `out/webview` at whatever it was, and with
the repository's checked-in (stale) webview the settings page has no `AI Endpoints`
section at all — step 2 below cannot be reached, and step 3 has nothing to click.
Ask for both and check both timestamps rather than running anything yourself
(`AGENTS.md`):

```bash
pnpm --filter forgejo-toolkit build:extension   # host: out/extension.mjs + chunks
pnpm --filter forgejo-toolkit build:webview     # webview: out/webview/**  <- the settings page
```

1. **Launch.** `pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch --ai-mock`.
   Expect three things before the window appears: the endpoint line (URL, pid), the
   profile line (provider, model, `auth "none"`), and then `CDP ready:`. Take a
   screenshot (`ui shot ai-mock-home`) and read the seeded address — it is the port
   the endpoint bound, and nothing else in the run knows it.
2. **Look at the settings page.** Open it (Dashboard → settings, or the
   `Forgejo Toolkit: Open Settings` command) and find the `AI Endpoints` section.
   Expect one row: `Local mock endpoint (tools/ui-review)`, the address
   `http://127.0.0.1:<port>/v1`, `mock-pre-review` in its model list, and no
   "key missing" state — the endpoint needs none. The `Feature Bindings` section
   should show **both** features the extension declares — `aiPreReview` and
   `prDescription` — bound to `ui-review-mock / mock-pre-review`: the seed writes
   one binding per declared feature (see "What `--ai-mock` writes into the
   profile"), which is what makes the description draft reachable from step 10.
3. **Test the connection.** Click the row's `Test connection` (the same code as the
   palette command `AI: Test Configured Endpoint`). Expect a report naming the
   address, `HTTP 200`, the elapsed time and
   `The endpoint reported 2 model(s) from "/models"`. Then prove it from the socket
   side — this is the part a screenshot cannot show:

   ```bash
   pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock requests
   ```

   Expect **`GET /v1/models`, `HTTP 200`, and nothing else from the probe**. That
   is the whole probe on this endpoint, not a truncated walkthrough: the test is
   `GET <base>/models` first, and when it reports model(s) the probe has already
   answered its question and returns (`packages/forgejo-toolkit/src/ai/testProvider.ts`,
   pinned by its `aiTestProvider` suite). The minimal
   `POST <base>/chat/completions` — one character, no `stream`, no `temperature` —
   is the **fallback**, and it is sent only when `/models` answers 404, 405 or 501,
   or answers an empty list _and_ the provider declares no model of its own. A
   `POST` here therefore means the model listing did not come back; check the
   report sentence, which then reads
   `The endpoint reported no models from "/models" …`. Nothing in the log at all
   means the extension never reached the endpoint.

4. **Run an AI pre-review.** Open the fixture pull request (`Add dark mode`, #2)
   from the dashboard's `Pull Requests · demo-repo` list and open its diff, then use
   the pre-review action — the sparkle in the **editor title** of the PR diff
   (`forgejoToolkit.aiPreReviewPullRequest`; it is contributed there, not in the
   command palette). The profile has `forgejoToolkit.aiPreReview: true`, so the
   action is there.
5. **Answer the consent modal — a human has to do this.** The first pre-review
   shows one native VS Code modal naming the destination; nothing is requested or
   sent until it is answered (`ask` is the default scope, and `--ai-mock` does not
   write it). It is a separate Win32 window and never appears in a CDP screenshot:
   use `powershell -File src/win/activate.ps1 -OutFile shots\screen.png` to see it
   and `powershell -File src/win/dialog.ps1 -Keys '{ENTER}'` to answer it, or just
   answer it by hand. On the direct path the sentence must name both the endpoint's
   display name and its address — that is §7.1's whole point (a `vscode.lm` run
   names the editor's model vendor instead).
6. **Read the destination in the log.** After the modal, `ai-mock requests` must
   show a new `POST /v1/chat/completions` with `sse` and `chunks=7` — a _second_
   one only if step 3 also sent one, which it does when the model listing failed;
   the probe's POST is not streamed. A streamed answer is possible only if the
   chunks were read as they arrived. In the
   extension's output channel (`Forgejo Toolkit`) the debug lines say which
   transport served the run, and — with `forgejoToolkit.debug` on, which the shared
   profile already has — `skipped 1 data line(s) that did not parse as JSON`, the
   deliberate bad line being counted rather than failing the run.
7. **Look at what came back.** The run proposes one comment anchored at
   `src/index.ts:2`; the normal confirmation list appears
   (`AI pre-review: review the proposed comments`), and confirming it writes drafts
   of a pending review — the extension never submits. If the panel instead reports
   the comment as dropped, check the prompt scope: `metadata-only` sends no diff, so
   there is no line to anchor to; the scopes that carry one
   (`changed-lines-only`, `full-diff`, `changed-files`) keep it.
8. **The failure faces, if you want them.** Append `?scenario=429` (or `401`, `500`)
   to the endpoint's address in the settings page, run the test again, and read the
   sentence the transport renders — the key is never printed. `?scenario=json`
   exercises the non-streaming fallback, `?scenario=truncated` the "answer was cut
   off" report, and `?scenario=stall` the idle watchdog
   (`forgejoToolkit.aiModelRequestTimeoutMs`, 30 s by default).
9. **Draft a pull-request description from the create form — the second bound
   feature** (`prDescription`, `docs/design/ai-pr-description.md`). Open the
   create-pull-request form on the fixture repository (the `Pull Requests` tab's
   new-pull-request action), pick two different branches, and press `Generate
description` under the body field. Three things to read, none of them from a
   screenshot alone:

   - **The draft lands in the body as editable text**, and the control's own state
     says it is _the draft_ and not the user's typing. Read both through the guest
     frame with a **static function body** — `ui eval` runs in the workbench page,
     which has no extension DOM (see "Traps this harness keeps re-learning"): the
     body's value out of the editor's CodeMirror instance, and the control's own
     state from its own labels (measured 2026-10-05: the button read `生成描述` with
     the ordinary hint while the body was an untouched draft, and showed the
     replace line once it was not). Then prove the text is editable with real
     input — click the editor, `ui type` one character, and read the value back: it
     must have grown by exactly that one.
   - **A press over an untouched draft replaces it without asking.** The form keeps
     one draft-ownership rule (`PullRequestForm.vue`): a press asks first — in the
     webview, as a plain line beside the control, not a modal — only when the body
     is the user's. So the sequence that shows it is: a press into an **empty**
     body drafts with no question (measured 2026-10-05, first press: the consent
     modal, then the run); a press right after, with the body still holding only
     that draft, drafts again with **no** "replace it?" line (measured: the button
     returned to `生成描述` with the ordinary hint, no replace line, and the next
     press went straight to the host); and a press after a real edit (click the
     editor, `ui type`) shows the replace line instead. Read that line, not the
     screenshot's mood: it is the `dashboard.form.generateDescriptionReplace`
     sentence, and it is the whole "ask".
   - **A press with the scope unanswered sends nothing.** With
     `forgejoToolkit.prDescriptionPromptScope` at its default `ask` and the modal
     dismissed, `ai-mock requests` must show **no** new
     `POST /v1/chat/completions`, and the body must be exactly what it was before
     the press. If the host log shows a request, the consent question did not stop
     the run.
   - **A failing endpoint's own sentence reaches the page**, with the body left
     byte-identical. Point the seeded provider's address at
     `http://127.0.0.1:<port>/v1?scenario=500` in the settings page, press again, and
     read the line beside the control: it must be the transport's sentence about the
     refused request, not a generic "the request could not be completed" — that
     generic sentence is what a lost reply looks like (`_dispatchMessage`'s
     fallback), and it is exactly what this step distinguishes. The body is compared
     byte for byte before and after.

10. **Clean up.** `pnpm kill` stops the dev host and the endpoint — and, because it
    proved the endpoint is gone, removes the endpoint's state file and its request
    log with it; `ai-mock stop` stops the endpoint alone, with the same two removals.
    The seeded settings stay in the profile — they are what the next `--ai-mock` run
    rewrites, and a later run without `--ai-mock` keeps whatever endpoint you
    configured by hand.

What a human has to do, stated plainly: **answer the consent modal** (a native
modal, step 5), and click in the webview if the agent is not driving it. Everything
else — starting, seeding, the HTTP traffic, reading the log, stopping — is done by
the commands above and by the extension itself.

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
pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual launch [workspace] [--real-api] [--ai-mock]  # first window, then window2
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
no mock API compiled in) and `--ai-mock [--ai-mock-port <n>]` (point the profile at
this harness's local model endpoint, exactly as `launch --ai-mock` does — see "The
local AI endpoint" above). The driver addresses a window either
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

- **Webviews are out-of-process iframes, and their DOM is reachable anyway.**
  Measured 2026-10-05 (VS Code 1.140 / Electron 43): the host is an
  `iframe.webview` in the workbench document, Playwright's frame list contains the
  guest document (`vscode-webview://…/index.html`) and `frame.evaluate` runs inside
  it, and the extension's own UI is that shell's nested `#active-frame`, whose
  `contentDocument` is same-origin and readable from the shell's frame. What the
  harness's own commands address is still the workbench page — `ui eval` always
  evaluates there — so a walkthrough is driven with coordinate clicks and
  screenshots. A DOM read of the guest is available to a script that connects over
  CDP itself, and it is how a click is proved to have reached the intended control
  rather than its neighbour. **A second measurement the same day adds one wrinkle**:
  the guest frame's `url()` came back **empty** — Playwright listed exactly two
  frames, the workbench and the shell, and the shell is the one with no URL — so a
  script that looks for `url().startsWith('vscode-webview://')` finds nothing. Take
  the frame that is not the main frame and confirm it by its `#active-frame`, whose
  `contentDocument` is where the extension's UI lives. **And it can be read without
  ever being compiled into there**: measured 2026-10-05, the guest's CSP has no
  `unsafe-eval`, so `eval` and `new Function` invoked from a script running in the
  shell are both refused, which makes a string that was built at run time — a
  template, a parameter — unusable inside the guest. Every script for the guest has
  to be a **static function body** handed to the frame (`frame.evaluate(() => { … })`,
  compiled by the CDP client's own context rather than by the page). `ui eval` is not
  affected: it evaluates in the workbench page, whose CSP is not the guest's.
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

`profile/` (persisted dev-host settings), `extensions/`, `shots/`, the AI mock
endpoint's `ai-mock.json` / `ai-mock.log` and the dual-window session file are
gitignored. Both endpoint files are also _removed_ by a stop that proves the endpoint
is gone (`pnpm kill`, `ai-mock stop` — see "Starting, watching and stopping it"
above), so a stopped run leaves neither behind. The launcher pre-seeds
`forgejoToolkit.useMockApi: true`, but **that setting alone does not give
you mock data**: `packages/forgejo-toolkit/src/extension.ts` starts the mock server only when
`process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS === 'true'`, and `packages/forgejo-toolkit/rolldown.config.mjs`
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
above).

Two more things the same setting does not cover, both measured 2026-10-05:

- **The handlers have to match the profile's instances.** They were `https://`-only
  while the seeded profile was `http://`, so intercepting never happened and the
  unmatched request went to the network. The handlers are scheme-agnostic now
  (`*://*/api/v1/…`) and the launcher refuses a profile the handlers still cannot
  serve, so "mock-backed" is either true or the run stops.
- **The webview is a second build.** The settings page and every other webview
  surface come from `out/webview`, which `build:extension` does not touch; the
  repository carries a checked-in copy, so a host-only rebuild silently serves the
  old UI. Rebuild `build:webview` too (see Prerequisites).

Treat a harness run as able to touch a real server: the polling
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
  items): `pnpm --filter forgejo-toolkit build:extension` (**host**) **plus**
  `pnpm --filter forgejo-toolkit build:webview` (**webview**), i.e. Rolldown and
  Vite, both _without_ the production flag. The host-only command leaves
  `out/webview` stale, and every flow below is driven through the webview — a
  host-only rebuild is how a walkthrough silently exercises the previous UI. The
  production build strips `src/test/mocks/`
  (`FORGEJO_TOOLKIT_INCLUDE_MOCKS=false`), so with it the Dashboard lists no
  repositories and every request goes to the real network.
- **production-shaped walkthroughs** (install the packaged `.vsix` instead):
  `pnpm --filter forgejo-toolkit build` (it runs both builds, in production mode),
  and point an instance at a real server.

Then run through the flows below; each one covers behaviour that unit tests
cannot observe (native modals, real git, real MCP clients). Numbers a walkthrough
produces (bundle size, render cost, activation time and the like) are recorded in
the commit that made the change and in that change's `CHANGELOG` entry, not in
`FEATURES.md`'s delivered list; a design document keeps only the measurements that
drove one of its decisions.

The local AI endpoint has its own procedure instead of an item here — it needs a
build that includes the model transport, plus its own start/stop commands. It is
the "Walkthrough: endpoint → test connection → pre-review → destination" section
of "The local AI endpoint: a real socket, deliberately not MSW" above.

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

- **The file picker (`showOpenDialog`) is the modern Common Item Dialog, and the
  honest way in is the clipboard plus a real mouse click.** Window messages
  (`WM_COMMAND`/`IDOK`, `BM_CLICK`) are ignored and neither the file-name box nor
  the buttons exist in its UI Automation subtree (both from the earlier
  walkthroughs). **`SendKeys` cannot type a Windows path** — `+ ^ % ~ ( ) { }` are
  SendKeys syntax, so a typed path is mangled rather than rejected — measured
  2026-10-05 in the isolated dev host, where `D:\code\test\ui-live\plain.json` and
  `D:\code\test\ui-live\import-endpoint.json` both arrived as
  `D:、浔得 特使田、ui—li、import-恩打欧`-shaped gibberish (an active IME compounds it:
  SendKeys feeds the IME, not the box), and the picker only answers such a value
  with its own "file not found" box. **The clipboard route works**: `Set-Clipboard`
  the text, activate the dialog, send `^a` then `^v` — measured, the box then read
  the exact path (its on-screen text is visible in
  `src/win/shot.ps1 -Dialog`'s `PrintWindow` render). `^a` matters: pasting into a
  box that already holds text **appends** to it, which is how one run produced
  `import-endpoint.jjsonjson` and an error box.
- **The picker's own window title is the breadcrumb, and its error box shares that
  title.** The Open dialog's title is its own word — `打开` on the Chinese-locale
  dev host this was measured on 2026-10-05 — so the title tells you which dialog
  answered, and `dialog.ps1 -Title '打开'` targets it. A path the picker cannot use
  raises an **error box whose title is exactly the picker's**
  (`#32770 :: 打开`, both of them): the two are one list entry apart and only their
  rect distinguishes them — measured `打开 rect=1089,583,366x163` for the error box
  beside `打开 rect=0,0,2560x1392` for the picker, with `dialog.ps1` refusing the
  pair as `ambiguous target: 2 dialogs match`. Read the rect from
  `src/win/shot.ps1 -Dialog` (it lists **every** visible `#32770`, largest first)
  and answer the error box by hand — its OK button has no row to click and no
  distinctive title, and it does accept `{TAB}`-then-`~`. `fileDialog.ps1 -Cancel`
  (Escape, `WM_CLOSE` fallback) and `-RowIndex` still work on the picker itself.
- Beware the classic `Edit` with
  control id 1148: it is a hidden legacy proxy — `SetWindowText` writes to it and
  reading it back confirms the text, while the box on screen stays empty, so Open
  reports "file not found" and it looks like the dialog accepted the path. Reading
  it back is therefore **not** a check of what the dialog will use: measured
  2026-10-05, `src/win/shot.ps1 -Dialog` printed `fileNameBox=[]` while the render
  beside it showed the box holding the pasted path. `PrintWindow` may likewise
  render the DirectUI file-name box empty even when it holds text, so never judge
  the value from the proxy control; judge it from the render, and confirm it by
  what the dialog does next.
- What works reliably for _selecting a file_ (`src/win/fileDialog.ps1`): flash the
  dialog TOPMOST and
  attach to the foreground thread so it can be activated, then click and
  double-click the file's row. Two consequences: the file must be in the folder
  the dialog already shows, and the row position has to be read from a capture —
  `src/win/shot.ps1 -Dialog` prints the geometry and saves a PNG of the
  `PrintWindow` render, which is the most reliable way to see this dialog's state.
  Only when `PrintWindow` fails does the script fall back to grabbing the screen
  area, and it says so in its summary line (`screenFallback=true`) so a capture
  that might show another window is never mistaken for the dialog's own render.
  Leftover dialogs are closed with `WM_CLOSE` on the dialog the caller selected.
  A path the picker rejects leaves the dialog open, which `dialog.ps1` reports as
  `dialogClosed=false` and a non-zero exit.
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
