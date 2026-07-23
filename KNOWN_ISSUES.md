# Known Issues

## Pull Request attachments are fetched from the Issue API

Forgejo's `GET /repos/{owner}/{repo}/pulls/{index}` endpoint does **not** return the `assets`/`attachments` field, even though the web UI shows them. However, the underlying PR is also accessible as an issue via `GET /repos/{owner}/{repo}/issues/{index}`, and that endpoint **does** return `assets`.

To display PR attachments in the detail view, `ForgejoClient.getPullRequestDetail` currently makes both requests and merges the `assets` array from the issue response into the PR detail. This is a workaround and may break if Forgejo changes the relationship between PRs and issues in the future.

Ideally, Forgejo would include `assets` directly in the pull request response, or expose a dedicated attachments endpoint for pull requests.

## Image attachments in Markdown require extension-host proxying

Forgejo attachment URLs (e.g. `/attachments/{uuid}`) require authentication. The VS Code webview cannot share cookies with the extension host, so `<img>` tags pointing directly at Forgejo are redirected to the login page and fail to render.

The extension works around this by fetching each image in the rendered Markdown HTML using the stored access token, converting it to a `data:` URL, and replacing the original `src` before returning the HTML to the webview.

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
