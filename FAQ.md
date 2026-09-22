# Frequently Asked Questions

## General

### What is Forgejo Toolkit?

Forgejo Toolkit is a VS Code extension for [Forgejo](https://forgejo.org/) and Codeberg. It provides a Webview-based dashboard, repository browsing, Issue / PR management, and PR worktree support without leaving VS Code.

### Does it support Gitea?

Forgejo and Gitea share API history, so many features may work against Gitea instances. However, this extension is tested against Forgejo only; Gitea compatibility is best-effort.

## Setup

### What access token permissions do I need?

Create a token in your Forgejo profile settings and grant at least:

- `repo` — read repositories, commits, branches, tags, and releases.
- `issue` — read and write Issues.
- `pull_request` — read and write Pull Requests.
- `attachment` — upload attachments for Issues / PRs.

### Where is my token stored?

Tokens are stored in VS Code's built-in `SecretStorage`, which uses the operating system's keychain or credential manager.

### Can I manage multiple Forgejo instances?

Yes. Open the settings page from the Dashboard and add as many instances as you need. Each instance keeps its own token.

## Features

### Why does the file tree not show icons?

Make sure `codicon.css` is loaded in the webview. The extension registers the required stylesheet automatically. If icons are still missing, check the Developer Tools console for network errors.

### Why does the PR diff editor not show M/R badges?

VS Code's diff editor does not expose added/modified/removed badges in the title area for virtual file systems. This is a known limitation documented in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

### Can I upload attachments when creating a Release?

Yes. Pick the files in the create-release dialog; the extension creates the release first and then uploads the queued attachments automatically. If some uploads fail, only those files stay queued so you can retry them.

### Why is the worktree cache directory configurable?

PR worktrees are checked out into a cache directory so they can be reused. You can change the directory in the settings if the default location is inconvenient.

## MCP Server

### Why can't I see the Forgejo instance in "MCP: List Servers"?

The MCP server is only registered when all of the following are true:

- You are running VS Code 1.102 or newer.
- At least one Forgejo instance is configured in the extension.
- That instance has an access token stored.

If any condition is missing, the extension silently skips registration — check these three points first.

### Can the AI agent modify my repository through this extension?

No. All MCP tools are currently read-only (`readOnlyHint`), so the agent can query issues, PRs, Actions runs, and code, but cannot change anything. Write tools may be added in the future as opt-in features — disabled by default and enabled one by one. Note that VS Code does not ask for confirmation before a read-only tool call, so the guarantee rests on the tool surface itself: every tool is a `GET`, and request-path inputs are validated so a crafted argument cannot reach a different endpoint.

## Troubleshooting

### Nothing happens when I click a repository

Check the `Forgejo Toolkit` Output Channel for errors. Common causes:

- Invalid or expired token.
- Network error reaching the Forgejo instance.
- Missing repository permissions.

### The Dashboard is blank

Open the Developer Tools in VS Code and look for JavaScript errors. Common causes include failed message initialization or a runtime error during the first render.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines. Report bugs or ask questions on [Codeberg Issues](https://codeberg.org/cpf23333/forgejo-toolkit/issues).
