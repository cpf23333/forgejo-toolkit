# Frequently Asked Questions

## General

### What is Forgejo Toolkit?

Forgejo Toolkit is a VS Code extension for [Forgejo](https://forgejo.org/) and Codeberg. It provides a Webview-based dashboard, repository browsing, Issue / PR management, and PR worktree support without leaving VS Code.

### Does it support Gitea?

No. The extension targets Forgejo only, with Forgejo 16.0 as its minimum version. A Gitea instance reports a 1.x version from `/api/v1/version`, which falls below that floor, and nothing in the extension accounts for Gitea's differences — requests the two platforms do not share fail rather than degrade. See "Gitea is not supported (the extension requires Forgejo 16.0 or newer)" in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).

### Can I use it on VSCodium or another VS Code fork?

Yes — the extension is published on [Open VSX](https://open-vsx.org/extension/cpf23333/forgejo-toolkit), which is the registry VSCodium and other VS Code forks read: search for "Forgejo Toolkit" in the Extensions view and install it directly. If your editor does not reach that registry, install the `.vsix` from the [release page](https://codeberg.org/cpf23333/forgejo-toolkit/releases) instead. Either way, everything except the AI integration works the same: dashboard, issues, PRs, worktrees, Actions, notifications.

The MCP server needs a consumer, and that is where the forks differ. VS Code's built-in consumer is Copilot agent mode, which is only available in Microsoft's official build. On a fork you therefore drive the MCP server from a **third-party agent** (Cline, Continue, …) or any MCP client: point it at the stable-path shim (`mcp-server.js` in the extension's globalStorage, see "Can I use the MCP server in the Agents window?" below for the exact path). The zero-configuration instance matching and the authenticated broker both work there, because they are implemented by the extension itself, not by VS Code's chat. Nothing needs to be disabled: on an editor whose MCP definition API is missing entirely, the extension skips that one registration and runs everything else normally.

### Does the extension send anything anywhere?

No. There is no telemetry, no crash reporting and no analytics: this extension contains no reporting code and depends on no reporting library. The only requests it makes go to the Forgejo instances you configure, with the token you stored — plus whatever the editor itself does when it checks for extension updates. Its logs stay on your machine: enable `forgejoToolkit.debug` and run **Forgejo Toolkit: View Log** to read them, and nothing uploads them.

Two boundaries are worth knowing, because they sit outside the extension's control:

- The MCP server answers whichever MCP client connects to it (Copilot agent mode, Cline, …). What that client does with the answer — including whether it leaves your machine — follows from that client's own settings, not from this extension; here the extension only serves the tool calls it receives.
- VS Code's own `telemetry.telemetryLevel` is a platform setting. Nothing in this extension calls a telemetry API, so it adds nothing to that stream either way.

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
- `forgejoToolkit.mcpEnabled` is on (the default).
- The extension host's local broker is running — it starts with the MCP feature, and an extension-provided definition carries no token of its own, so it cannot authenticate without it.

If any condition is missing, no server is registered, and the extension says why in the log rather than skipping silently: a missing broker is logged at info level as "MCP server definitions withheld". The static `mcp.json` route still works in that case — it reads anonymously, public data only, when no window is running. Turning `forgejoToolkit.mcpEnabled` off withdraws the server definitions immediately (no window reload needed) and also stops the workspace-repository mapping and the local broker; a client that is _already_ connected keeps the server process VS Code spawned for it until you reload the window, because the extension never owned that process.

### How do I tell an agent which repository this workspace maps to?

Run **Forgejo Toolkit: Write Copilot Instructions**. It resolves the workspace's repository through the same detection the MCP tools use (including nested checkouts, which get their own file), finds the matching configured instance, and writes a short, delimited section into `.github/copilot-instructions.md` of that checkout: it names the `<instance>/<owner>/<repo>` the workspace maps to and says that the read-only `forgejo-toolkit` MCP tools are available for it.

The file is created when it does not exist. An existing file keeps all of its own content: with no Forgejo section yet, the section is appended after a blank line; when the section is already there, it is updated in place (or left alone when it is current) and never duplicated. A file whose markers are incomplete or duplicated is left completely alone, with a warning — the command would rather change nothing than guess. When no configured instance matches the workspace, it says so and writes no file. The written text promises read-only access only, and the instance URL is written without any credentials it may carry.

### Can the AI agent modify my repository through this extension?

Only if you deliberately turn it on, one tool at a time. The 30 query tools are read-only (`readOnlyHint`), so with them alone the agent can read issues, PRs, Actions runs and code but cannot change anything. Three **write** tools exist — `create_issue_comment` (one issue or pull request comment), `submit_pull_review` (submit a pending PR review as `COMMENT`, `APPROVED` or `REQUEST_CHANGES`) and `cancel_action_run` (cancel a pending or running Actions workflow run) — and each is off by default behind its own setting (`forgejoToolkit.mcpWriteTools.createIssueComment` / `forgejoToolkit.mcpWriteTools.submitPullReview` / `forgejoToolkit.mcpWriteTools.cancelActionRun`); nothing else is planned or implemented. A write tool declares no `readOnlyHint`, so VS Code asks you to confirm every call and lets you edit the parameters there. It also requires a session **the extension host itself established**: a launch that only carries a token from your own `mcp.json`, or no token at all, gets a plain refusal naming the setting instead of writing. `cancel_action_run` is the one whose effect is a stop rather than new text: it cancels the run's pending or running jobs, and the run has to be triggered again afterwards.

For the read half, VS Code does not ask for confirmation before a read-only tool call, so the guarantee rests on the tool surface itself: every read tool is a `GET` (the one exception, `get_workspace_repository`, only reads a local state file the extension publishes), and request-path inputs are validated so a crafted argument cannot reach a different endpoint. Every write call is additionally recorded in the `Forgejo Toolkit` Output Channel — caller, instance, repository, target, tool, body size and digest, result and duration, never the text.

### What does "Configure Model Access" do for this MCP server?

Nothing today. VS Code shows that menu entry for every MCP server; it controls which models a server may use through MCP _sampling_ (server-initiated model calls). This extension's server never requests sampling — it only serves tool calls, read-only ones unless you turned a write switch on — so the setting has no effect on it.

### Can I use the MCP server in the Agents window?

Not through the extension's contribution: VS Code does not resolve extension-contributed MCP servers in Agents window (Agent Host) sessions — a platform limitation, which is why the extension does not declare the `agentsWindow` capability. What works is a static MCP configuration pointing at the shim the extension maintains in its globalStorage:

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

(On macOS the directory is `~/Library/Application Support/Code/User/globalStorage/cpf23333.forgejo-toolkit`, on Linux `~/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit`; Insiders builds use `Code - Insiders` instead of `Code`.) Where the snippet should live: the user-level `<profile>/User/mcp.json` is recommended (VS Code's registry — applies to every workspace of the profile and is forwarded to Agent Host sessions); a workspace `.vscode/mcp.json` works for one workspace only. A `.mcp.json` at the workspace root is read natively by the Agent Host only — VS Code ignores it, and worktree-isolated sessions never see it. You can write the file by hand or run the **Forgejo Toolkit: Copy MCP Config for Agents Window** command, which merges the snippet into the user-level `mcp.json`, the workspace `.vscode/mcp.json`, or copies it to the clipboard. The path is the shim `mcp-server.js`, not the versioned install directory: the extension rewrites it on every activation, so it survives extension upgrades.

No environment variables are needed: the server discovers the extension's published instance registry and auto-matches the instance from the session workspace's git remote, falling back to the most recent workspace state file the extension published when the working directory matches nothing. While any extension window with the MCP feature enabled is running, the server additionally forwards into the extension host's local broker and gets authenticated tools without any token in this file; with no window running it reads anonymously (public data only) unless you set `FORGEJO_MCP_TOKEN`. The zero-configuration variant contains no secrets, but still avoid committing `.mcp.json` into git — the absolute path is machine-specific, and an `env` block with a token would be a secret at rest in a shareable file.

### Why do `whoami` and account-level calls answer "Invalid or expired credentials" in the Agents window?

That server is running without a token — which happens when **no VS Code window with the extension is running**, or when `forgejoToolkit.mcpEnabled` is off, since the broker belongs to that feature. While any extension window is open with the MCP feature enabled, the statically launched server forwards into the extension host's local broker, and the broker executes the tools with the token inside the host process, so `whoami` works in the Agents window without any token in the config file. If you do see credential errors there, check that a VS Code window with Forgejo Toolkit activated is actually running and that `forgejoToolkit.mcpEnabled` is on — the broker starts with the MCP feature, not with activation alone.

The background: an MCP server started from a static `mcp.json` is launched by VS Code's Agent Host, not by the extension — and only the extension host may read tokens from VS Code SecretStorage. It does not hand them to any child process: VS Code persists every registered server definition, environment included, in the profile's workspace storage, so the definitions the extension provides carry the instance's identity only — URL, instance id, workspace mapping — and never a credential, and the extension never puts one in a launch environment either. Nothing reaches into SecretStorage from an external process: that boundary is deliberate (it is what keeps tokens off disk and out of logs), so there is no "just read it from the extension" path. The broker exists precisely to bridge that boundary without breaking it: the token never leaves the extension host; the forwarder only proves it is a same-user local process via a per-launch handshake secret published in the extension's globalStorage, and it names the instance its definition was created for so the host — not the child — decides which account serves the session. A token you write into your own `mcp.json` `env` block is your file and your choice; it is not something this extension generates or reads.

What you can do when running without any extension window:

- Use the main window's Copilot chat for account-level operations — the extension-contributed server there reaches the instance through the extension host's broker, which holds the token, so `whoami` and other authenticated calls work without any token in a config file.
- Or add the token yourself: `"env": { "FORGEJO_MCP_TOKEN": "<your token>" }` in the server entry of the user-level `mcp.json`. That is a plaintext secret at rest in your private user directory — acceptable, but know what you are doing, and prefer a token scoped to read-only access.

## Troubleshooting

### Nothing happens when I click a repository

Check the `Forgejo Toolkit` Output Channel for errors. Common causes:

- Invalid or expired token.
- Network error reaching the Forgejo instance.
- Missing repository permissions.

### The Dashboard is blank

Open the Developer Tools in VS Code and look for JavaScript errors. Common causes include failed message initialization or a runtime error during the first render.

### Why can't I write a setting that a new version added?

Configuration keys are registered when a window starts, from the manifest of the extension version that window loaded. A window that was already open when the extension updated is therefore still serving the previous manifest: a key the new version adds is unknown there, and writing that setting fails with a message saying the configuration is not registered, so the value cannot be written to user settings. **Reloading the window makes it writable — this is not a defect.**

Before reloading, you can confirm that this is what you are looking at:

- In the **Extensions** view, the extension shows the new version; if it also offers **Reload Required**, accept it.
- Search for the setting id in VS Code's own settings UI: if nothing matches, that window is still running the old manifest.
- In a terminal, `code --list-extensions --show-versions` corroborates the installed version.

Then run **Developer: Reload Window** (or restart the editor) and write the setting again.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines. Report bugs or ask questions on [Codeberg Issues](https://codeberg.org/cpf23333/forgejo-toolkit/issues).
