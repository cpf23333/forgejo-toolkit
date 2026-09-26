---
'forgejo-toolkit': patch
---

Tolerate editors without the MCP server definition API (VS Code forks): MCP server registration is now skipped with a log line instead of risking a failed activation, while the workspace-state sync — which the static-config MCP path consumed by third-party agents relies on — still starts. The FAQ explains how to use the extension on VSCodium and other forks (Open VSX, and driving the MCP server from a third-party agent via the stable-path shim).
