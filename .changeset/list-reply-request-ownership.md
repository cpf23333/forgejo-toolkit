---
'forgejo-toolkit': patch
---

Answer a webview list request only the webview that made it. `getRepositories`, `getMyIssues` and `getMyPullRequests` now carry a `_requestId` in the request, the host echoes it back on both the reply and the failure reply, and the webview attributes a reply strictly by that id — so a late reply from a server that has since been replaced (or from an instance the user just removed) can no longer land in the list or the cache, whatever order the replies arrive in. The setup wizard echoes the request id the same way, because it shares the `getRepositories` dispatcher with the sidebar.
