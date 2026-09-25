# Frequently Asked Questions

## General

### What is Forgejo Toolkit?

Forgejo Toolkit is a VS Code extension for [Forgejo](https://forgejo.org/) and Codeberg. It provides a Webview-based dashboard, repository browsing, Issue / PR management, and PR worktree support without leaving VS Code.

### Does it support Gitea?

Forgejo and Gitea share API history, so many features may work against Gitea instances. However, this extension is tested against Forgejo only; Gitea compatibility is best-effort.

## Setup

### What access token permissions do I need?

Create a token in your Forgejo profile settings and grant at least the read scopes:

- `read:user` — account info, user search, time tracking.
- `read:repository` — repositories, files, pull requests, reviews, CI, releases.
- `read:issue` — issues, comments, labels, milestones.
- `read:notification` — notification polling.

Grant the matching write scopes (`write:repository`, `write:issue`, `write:notification`) when you want to create or edit anything. Forgejo has no `pull_request` scope: pull request endpoints fall under the repository category. The setup form lists the same scopes.

### Where is my token stored?

Tokens are stored in VS Code's built-in `SecretStorage`, which uses the operating system's keychain or credential manager.

### Can I manage multiple Forgejo instances?

Yes. Open the settings page from the Dashboard and add as many instances as you need. Each instance keeps its own token.

## Features

### Why does the file tree not show icons?

Make sure `codicon.css` is loaded in the webview. The extension registers the required stylesheet automatically. If icons are still missing, check the Developer Tools console for network errors.

### Why does the PR diff editor not show M/R badges?

VS Code's diff editor shows **A** (added) and **D** (deleted) badges natively, because one side of the diff is empty. The **M**/**R** badge for a modified or renamed file is normally resolved by the built-in Git extension, which needs the repository open as a workspace folder; viewed without a local checkout, both sides of the diff still render correctly but no **M**/**R** badge appears next to the file name. This is a known limitation documented in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

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

No. All MCP tools are currently read-only (`readOnlyHint`), so the agent can query issues, PRs, Actions runs, and code, but cannot change anything. Write tools may be added in the future as opt-in features — disabled by default and enabled one by one. Note that VS Code does not ask for confirmation before a read-only tool call, so the guarantee rests on the tool surface itself: every tool is a `GET` (the one exception, `get_workspace_repository`, only reads a local state file the extension publishes), and request-path inputs are validated so a crafted argument cannot reach a different endpoint.

### What does "Configure Model Access" do for this MCP server?

Nothing today. VS Code shows that menu entry for every MCP server; it controls which models a server may use through MCP _sampling_ (server-initiated model calls). This extension's server never requests sampling — it only serves read-only tool calls — so the setting has no effect on it.

### Can I use the MCP server in the Agents window?

Not through the extension's contribution: VS Code does not resolve extension-contributed MCP servers in Agents window (Agent Host) sessions — a platform limitation, which is why the extension does not declare the `agentsWindow` capability. What works is a static workspace `.mcp.json` pointing at the shim the extension maintains in its globalStorage:

```json
{
  "servers": {
    "forgejo": {
      "command": "node",
      "args": ["%APPDATA%\\Code\\User\\globalStorage\\cpf23333.forgejo-toolkit\\mcp-server.js"]
    }
  }
}
```

(On macOS the directory is `~/Library/Application Support/Code/User/globalStorage/cpf23333.forgejo-toolkit`, on Linux `~/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit`; Insiders builds use `Code - Insiders` instead of `Code`.) You can write the file by hand or run the **Forgejo Toolkit: Copy MCP Config for Agents Window** command, which copies the snippet to the clipboard or merges it into the workspace's `.mcp.json`. The path is the shim `mcp-server.js`, not the versioned install directory: the extension rewrites it on every activation, so it survives extension upgrades.

No environment variables are needed: the server discovers the extension's published instance registry and auto-matches the instance from the session workspace's git remote. Without `FORGEJO_MCP_TOKEN` it reads anonymously (public data only). The zero-configuration variant contains no secrets, but still avoid committing `.mcp.json` into git — the absolute path is machine-specific, and an `env` block with a token would be a secret at rest in a shareable file.

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
