# Known Issues

## Pull Request attachments are fetched from the Issue API

Forgejo's `GET /repos/{owner}/{repo}/pulls/{index}` endpoint does **not** return the `assets`/`attachments` field, even though the web UI shows them. However, the underlying PR is also accessible as an issue via `GET /repos/{owner}/{repo}/issues/{index}`, and that endpoint **does** return `assets`.

To display PR attachments in the detail view, `ForgejoClient.getPullRequestDetail` currently makes both requests and merges the `assets` array from the issue response into the PR detail. This is a workaround and may break if Forgejo changes the relationship between PRs and issues in the future.

Ideally, Forgejo would include `assets` directly in the pull request response, or expose a dedicated attachments endpoint for pull requests.

## Image attachments in Markdown require extension-host proxying

Forgejo attachment URLs (e.g. `/attachments/{uuid}`) require authentication. The VS Code webview cannot share cookies with the extension host, so `<img>` tags pointing directly at Forgejo are redirected to the login page and fail to render.

The extension works around this by fetching each image in the rendered Markdown HTML using the stored access token, converting it to a `data:` URL, and replacing the original `src` before returning the HTML to the webview.

## Issue/PR attachment upload during creation requires two API calls

The official Forgejo API only provides `POST /repos/{owner}/{repo}/issues/{index}/assets`, which requires an existing issue or pull request. There is no endpoint to attach files while creating the issue or PR.

Forgejo's web UI has a generic `POST /{owner}/{repo}/issues/attachments` endpoint used by browser forms when _creating_ a new issue or PR. However, this web route is part of the session-based auth group and does **not** accept API access tokens (`Authorization: Bearer`/`token`). The extension therefore cannot use it and falls back to the official API endpoint.

The extension works around this by creating the issue or PR first and then uploading the pending attachments in a second step. From the user's perspective, files can be selected before creation and are uploaded automatically after the item is created.

Uploading still requires the access token to have the **`write:issue`** scope. If the token only has read scopes, the upload endpoint returns a 403 error: `token does not have at least one of required scope(s): [write:issue]`.

## Forgejo's pull request files API may omit deleted files

Forgejo's `GET /repos/{owner}/{repo}/pulls/{index}/files` endpoint does not always return the same list of changed files that the Forgejo web UI shows.

In one test PR the web UI reported 6 changed files (including a deleted file), but the API returned only 5 files and omitted the deleted file.

The extension now uses the `GET /repos/{owner}/{repo}/compare/{basehead}` endpoint to build the PR-level changed-file list. This returns the net diff between the PR base and head, including files that are deleted in the overall PR. Files that are added in one commit and removed in another commit do not appear in the net list, which is correct for a full-PR view but differs from a per-commit view.

A future improvement could add a per-commit diff mode to show the changes introduced by each individual commit (see TODO.md / ROADMAP.md).

## Modified/renamed files do not show an M/R badge in the multi-file diff editor

When opening a PR's changed files in VS Code's multi-file diff editor (`vscode.changes`), added files show an **A** badge and deleted files show a **D** badge natively because one side of the diff is empty.

For modified or renamed files, VS Code normally resolves the **M**/**R** badge through the built-in Git extension, which requires the repository to be open as a workspace folder. When the PR is viewed without a local checkout, the multi-file diff editor correctly renders both sides of the diff but does not display an **M** or **R** badge next to the file name.

We register a `FileDecorationProvider` for the custom `forgejo-pr:` scheme, but VS Code currently invokes it only with internal `multi-diff-editor:` wrapper URIs in this context, not with the underlying resource URIs, so the provider cannot supply the missing badge. We also tried using a local workspace `file:` URI as the resource URI for modified files, but that did not cause VS Code to display the badge either.

At the moment the only way to guarantee M/R badges would be to build a custom diff viewer webview instead of using `vscode.changes`. There is no short-term workaround.

## Opened worktrees appear in VS Code's recent folders history

When the extension opens a worktree with `vscode.openFolder`, VS Code automatically adds that folder path to its own "Recent" / "Open Recent" history. There is no extension API parameter to open a folder while suppressing this entry.

This is expected VS Code behavior, not a bug in the extension. If you want to avoid cluttering the recent list, you can manually remove entries from VS Code's **File > Open Recent** menu.

## Release attachment upload during creation requires two API calls

The Forgejo API endpoint for uploading release attachments is `POST /repos/{owner}/{repo}/releases/{id}/assets`, which requires the release to already exist. There is no endpoint to attach files during release creation.

The extension works around this by creating the release first and then uploading the pending attachments in a second step. From the user's perspective, files can be selected before creation and are uploaded automatically after the release is created.

## Release "use title and content as tag message" cannot be replicated through the API

Forgejo's web UI offers a checkbox to copy the release title and body into the underlying tag message when the tag is created automatically. However, the official `CreateReleaseOption` / `EditReleaseOption` schemas do not expose a `tag_message` field.

The extension therefore does not implement this checkbox; the tag message is left to Forgejo's default behavior when it creates the tag from `target_commitish`.

## Action run steps are not exposed through the REST API

Forgejo's web UI shows individual job steps (e.g., "Set up job", "actions/checkout", "Run tests") with their status and duration, but the official REST API does not expose step-level data.

The available endpoints (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` and `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`) only provide job-level information and logs. The web UI renders steps by scraping internal page data (`data-initial-post-response`) from the HTML job page, which is not accessible through the token-authenticated API.

The extension therefore shows job-level status and logs only. Step-level breakdown would require either a new Forgejo API endpoint or falling back to web-page scraping, which has auth limitations for private repositories.

## Re-running an action run is not exposed through the REST API

Forgejo's web UI allows users to re-run a completed workflow run, but there is no corresponding endpoint in the official REST API. The `/repos/{owner}/{repo}/actions/runs/{run_id}/cancel` endpoint exists for cancelling pending or running jobs, but no `/rerun` or `/re-run` endpoint is documented or implemented in the API router.

Verified against the Forgejo server source: re-run only exists as the session-authenticated web route `POST /{owner}/{repo}/actions/runs/{run}/rerun` (registered in `routers/web/web.go`, handler `routers/web/repo/actions/view.go`), while `routers/api/v1/api.go` registers no rerun route. Simulating the web form request from the extension is not advisable, so this is accepted as a platform limitation.

The extension therefore provides "Cancel run" for active runs but does not offer a "Re-run" button. Users can re-run a workflow by triggering it again through the "Trigger workflow" button if the workflow supports `workflow_dispatch`.

## PR diff line comments cannot be created via the gutter + icon

VS Code's stable Comments API does not expose `CommentController.onDidCreateCommentThread`, so the extension cannot detect when a user clicks the gutter `+` icon in a diff editor. Without that event, enabling the gutter button would only show a comment input box that cannot be submitted.

New pull-request review comments are therefore added through the editor context-menu command **Add Pull Review Comment** instead. Existing comments are still rendered as `CommentThread`s on the appropriate base/head line. This is a limitation of the stable VS Code API; there is no short-term workaround.

## Base-side review comments do not render in inline diff mode

When a PR file diff editor (`forgejo-pr:` scheme) is in inline (unified) mode, review comments anchored to the base (old/left) side of the diff do not render at all — neither the comment thread widget nor the range highlight appears. The same comments render correctly in side-by-side mode, and head-side (new/right) comments are unaffected in both modes.

This is a VS Code projection limitation: in inline mode the original and modified documents are projected into a single view, and comment threads attached to the original-side document are not displayed. Extension-side logs confirm the threads and decorations are created and applied correctly; VS Code simply does not show them in the inline projection.

Workaround: switch the diff editor to side-by-side mode (**Compare: Toggle Inline View**) to see base-side comments, or open them from the **Comments** panel, where all threads are listed regardless of view mode.

## The last line of a multi-line review comment highlight has a slightly different shade

VS Code's native comment-thread range decoration is an inline decoration: the first and interior lines of a multi-line comment range are painted full width, but the final line is only tinted up to the range's end column, which reads as "the last line is not highlighted". The extension supplements the final line with its own whole-line decoration using the same theme color (`editorCommentsWidget.rangeBackground`), applied only while the comment thread is expanded.

The supplement cannot be pixel-perfect. VS Code paints its decoration through an internal CSS class while extensions can only paint through the editor decoration API, and the two composite differently with the translucent diff backgrounds underneath. As a result the final line's shade can look slightly different from the lines above it, most noticeably on added (green) diff lines, regardless of how many overlapping comments anchor on the range. An opaque supplement color is not an option either: extensions cannot resolve a theme color to its RGB value, so the blended color cannot be reproduced, and a hardcoded color would break other themes.

This is cosmetic only — the comment range itself (widget anchor, line labels, Forgejo web UI) is correct.

## Clicking the PR diff editor gutter sets an accidental breakpoint

In the PR file diff editor (`forgejo-pr:` scheme, inline/unified mode), the modified side keeps a ~19px glyph margin between the original-side and modified-side line-number columns. Clicking that strip sets a breakpoint on the read-only diff document, exactly like in a regular file editor — verified on a default-profile dev host with no `debug.allowBreakpointsEverywhere` or other custom settings.

The breakpoint is useless and confusing: the document is a read-only snapshot addressed by sha that no debugger can ever bind to, and the strip sits right next to the line numbers whose context menu carries **Add Pull Review Comment**.

The extension cannot prevent this. Diffs are opened with the `vscode.diff` command, whose options carry no editor settings (there is no way to disable `editor.glyphMargin` per diff), and gutter clicks are handled by VS Code's built-in editor contributions rather than by a command with a `when` clause that a context key could gate.

Workaround: delete the stray breakpoint in the **Run and Debug** view (or run **Debug: Remove All Breakpoints**). The heavy-handed alternative is setting `editor.glyphMargin: false`, which affects every editor.

## Project boards are not exposed through the REST API

Forgejo's web UI provides project boards for repositories and organizations, including creating projects, managing columns, and assigning issues to projects. However, the official v1 REST API does not expose any `/projects` endpoints.

The only project-related fields available through the API are:

- `has_projects` on repository settings, which only controls whether the project unit is enabled.
- `project_id` / `old_project_id` on `TimelineComment`, which record when an issue was moved between projects.

There is no API to list, create, update, or delete projects, and no API to assign or remove an issue from a project. Because of this, the extension cannot provide project board functionality.

This is a Forgejo API limitation. Project board support would require Forgejo to expose dedicated project endpoints in the v1 REST API.

## Inline diff view may render `undefinedundefined` instead of line numbers

We observed once that when a PR file diff editor was narrow enough to switch to inline (unified) mode, the line-number gutter next to a comment zone widget rendered the literal text `undefinedundefined` instead of a line number. Side-by-side mode was unaffected, and the glitch did not reappear after toggling the view mode or reloading.

This appears to be a transient VS Code rendering race involving comment zone widgets inside an inline diff editor, not something the extension draws: the extension does not use any decoration or line-number API, and a native Git diff of the same file renders correctly in inline mode because it has no comment widgets attached.

Workaround if it happens: toggle the view mode (**Compare: Toggle Inline View**) or reload the window.

## Branch names containing `/` may 404 behind reverse proxies that decode `%2F`

The extension percent-encodes branch/tag/ref path parameters (`feature/foo` → `feature%2Ffoo`). Verified against the Forgejo server source: a global middleware forces chi to route on the escaped path (`RawPath`) and unescapes route parameters afterwards, so encoded slashes work on every route — including single-segment ones such as `git/trees/{sha}`, contrary to what one might expect from chi's defaults.

Some reverse proxies (certain nginx/Apache configurations) decode `%2F` back to `/` before forwarding, which splits the parameter into extra path segments and makes the request 404. Affected features include file search and anything else that addresses a branch by name.

Workaround: configure the proxy to forward the escaped path unchanged (for nginx, a `proxy_pass` without a URI part does not decode), or avoid `/` in branch names. The extension cannot detect or repair proxy-side decoding.

## Only plain-http third-party images are blocked by the webview CSP

The webview Content-Security-Policy allows `https:` images from any origin, so third-party https images in issue/PR bodies — including gravatar avatars, which Forgejo returns for users without an uploaded avatar — render normally. The origins of the configured instances are additionally allowlisted explicitly, so images served by an `http://` instance itself also load.

Only `http://` images from other hosts (cleartext third-party links) are refused by the browser and show as broken images. Workaround: open the issue/PR in the browser to see them.

The same CSP also restricts `connect-src` to webview resources, but this has no user-visible effect: the webview never makes direct network requests — everything goes through the extension host via postMessage.

## PR diffs cannot show the old path of a renamed file

The PR-level changed-file list is built from `GET /repos/{owner}/{repo}/compare/{basehead}` (see the deleted-files entry above). That endpoint returns Forgejo's `CommitAffectedFiles` struct, which carries only `filename` and `status`, and its status values are limited to `added`, `removed` and `modified` — it has no `previous_filename` and never reports `renamed`.

A rename therefore arrives as an unrelated `removed` + `added` pair with no linkage between the two paths, and the extension cannot tell which removed file corresponds to which added one when several files changed in the same range. The base side of such a file is fetched under the new path, so the diff editor shows an empty left-hand side.

Workaround: use the Forgejo web UI for the diff of a renamed file, or check out the PR locally (`$ git diff -M` detects the rename). The per-commit and `/pulls/{index}/files` code paths do return `previous_filename` and are unaffected.

## Forgejo 15 (below the supported minimum) lacks the Actions sub-endpoints

The supported minimum is Forgejo 16.0 (see the README compatibility section). The extension reads workflow runs, jobs, job logs and artifacts, and can cancel or delete a run. Only `GET /actions/runs` and `GET /actions/runs/{run_id}` exist in Forgejo 15; the endpoints behind the other features (`/actions/runs/{run_id}/jobs`, `/artifacts`, `/actions/jobs/{job_id}/logs`, `/actions/runs/{run_id}/cancel`, `DELETE /actions/runs/{run_id}`) were added in Forgejo 16.

On a Forgejo 15 instance the run detail page therefore shows no jobs and no artifacts, and the log viewer, cancel and delete actions fail with a 404. Because the minimum is a soft warning rather than a hard block, those features stay visible and fail per request.

Workaround: upgrade the instance to Forgejo 16 or newer — that is also the version the extension is validated against.

## Repositories configured with url.insteadOf cannot be linked

`git remote -v` and `git remote get-url` print the URL _after_ applying `url.<base>.insteadOf` rewriting, so a repository whose remote is configured as a shorthand (for example `work:owner/repo.git` rewritten to a different host) reports a host that does not match any configured instance.

As a result the repository is not detected as linked: the dashboard shows no linked repository, the "Publish to Forgejo" button is offered again, and pushes are blocked because the extension refuses to send the access token to a host it cannot verify.

Workaround: add a remote whose URL contains the instance host verbatim, or configure the rewrite the other way around (put the full instance URL in the remote and rewrite it for other tools).

## Files larger than 10 MiB render as empty

Forgejo's contents API omits the payload of files above `[api] DEFAULT_MAX_BLOB_SIZE` (10 MiB by default): it returns `content: ""` together with the real `size` instead of failing. The extension renders that as an empty document (repository browser and PR diff alike), and the repository dashboard shows no README for a large `README.md`.

Workaround: open the file through the Forgejo web UI or a local checkout.

## Lists are capped at 500 items without a truncation notice

Paged list endpoints (issues, pull requests, commits, comments, tracked times, reactions, branches, tags, releases, labels, milestones, repositories, artifacts) stop after 500 items, and only the repository file search reports that its result was cut off. A repository or account with more matching entries therefore shows a silently incomplete list.

Workaround: narrow the list with the extension's filters or keyword search, or use the Forgejo web UI for a complete view.

## HTTP proxy settings are not honored

Requests use the Node `fetch` implementation, which ignores `HTTP_PROXY`/`HTTPS_PROXY` and the editor's `http.proxy` setting. On a network that only reaches the internet through a proxy, every request fails with a connection error even though the editor itself can reach the instance.

Workaround: point the instance URL at a host that is reachable directly — a reverse proxy or tunnel in front of the Forgejo server — or run the editor on a network with direct access.

---

_For per-endpoint verification details against the Forgejo server source, see [`docs/api-verification-checklist.md`](docs/api-verification-checklist.md)._
