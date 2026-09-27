---
'forgejo-toolkit': patch
---

Stop handing the access token to the editor's MCP server definitions — VS Code
persists them, environment included, in the profile's workspace storage, so the
token was landing on disk in cleartext beside SecretStorage. Extension-provided
servers now forward to the extension host's local broker (the path the static
`mcp.json` shim already used) and name the instance instead of authenticating to
it; the broker resolves that name against its own token-bearing instances and
refuses the session rather than serving a different account. When no broker is
reachable the extension publishes no definition and says so, instead of
registering a server that would read anonymously while the client believed it was
authenticated. A `mcp.json` you write yourself is unchanged. Also: the polling
diagnostics report now records the accurate handover reason on both sides of a
handover and a real `handover.latencyMs` where one is measurable (`null` plus a
reason where it is not, instead of a `0` that meant "unknown"), and its window
list is renamed `allWindows` → `visibleWindows` because a quiet follower is not in
it.
