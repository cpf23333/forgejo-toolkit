---
'forgejo-toolkit': patch
---

Read the `X-Total-Count` response header on the paged list endpoints (repositories, repository issues and pull requests, notifications), so truncation reporting is exact whenever the server reports a total: a list of exactly 500 items whose total agrees no longer shows a "may be incomplete" notice, and a total above the loaded rows proves the list was actually cut. The notification poller now pages precisely — `ceil(total / page size)` requests with no empty look-ahead page — when a total is reported, and a non-empty page that matches the total counts as the whole unread set. Instances that omit the header keep the previous length-based heuristic everywhere, unchanged, and the MCP tool result shapes are intentionally untouched.
