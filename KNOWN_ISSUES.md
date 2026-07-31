# Known Issues

## Pull Request attachments are fetched from the Issue API

Forgejo's `GET /repos/{owner}/{repo}/pulls/{index}` endpoint does **not** return the `assets`/`attachments` field, even though the web UI shows them. However, the underlying PR is also accessible as an issue via `GET /repos/{owner}/{repo}/issues/{index}`, and that endpoint **does** return `assets`.

To display PR attachments in the detail view, `ForgejoClient.getPullRequestDetail` currently makes both requests and merges the `assets` array from the issue response into the PR detail. This is a workaround and may break if Forgejo changes the relationship between PRs and issues in the future.

Ideally, Forgejo would include `assets` directly in the pull request response, or expose a dedicated attachments endpoint for pull requests.

## Image attachments in Markdown require extension-host proxying

Forgejo attachment URLs (e.g. `/attachments/{uuid}`) require authentication. The VS Code webview cannot share cookies with the extension host, so `<img>` tags pointing directly at Forgejo are redirected to the login page and fail to render.

The extension works around this by fetching each image in the rendered Markdown HTML using the stored access token, converting it to a `data:` URL, and replacing the original `src` before returning the HTML to the webview.

## Issue/PR attachment upload is only available when editing existing issues/PRs

The official Forgejo API only provides `POST /repos/{owner}/{repo}/issues/{index}/assets`, which requires an existing issue or pull request.

Forgejo's web UI also has a generic `POST /{owner}/{repo}/issues/attachments` endpoint used by browser forms when _creating_ a new issue or PR. However, this web route is part of the session-based auth group and does **not** accept API access tokens (`Authorization: Bearer`/`token`). The extension therefore cannot use it and falls back to the official API endpoint.

As a result, image uploads are only available while **editing** an existing issue or PR. When creating a new issue or PR, the editor still shows the normal image link button, but uploading a file is not supported.

Uploading also requires the access token to have the **`write:issue`** scope. If the token only has read scopes, the upload endpoint returns a 403 error: `token does not have at least one of required scope(s): [write:issue]`.

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

## Release attachments can only be uploaded while editing an existing release

The Forgejo API endpoint for uploading release attachments is `POST /repos/{owner}/{repo}/releases/{id}/assets`, which requires the release to already exist. There is no endpoint to attach files during release creation.

Consequently, the release dialog only shows the attachment upload area when editing an existing release. Attachments must be added after the release has been created.

## Release "use title and content as tag message" cannot be replicated through the API

Forgejo's web UI offers a checkbox to copy the release title and body into the underlying tag message when the tag is created automatically. However, the official `CreateReleaseOption` / `EditReleaseOption` schemas do not expose a `tag_message` field.

The extension therefore does not implement this checkbox; the tag message is left to Forgejo's default behavior when it creates the tag from `target_commitish`.
