---
'forgejo-toolkit': minor
---

Add the `get_pr_review_brief` MCP tool: one call returns the pull request header, the diff statistics (with a per-file additions/deletions table), each reviewer's latest conclusion with an aggregate summary, and the unresolved inline review comments — replacing the four calls (`get_pull_request` + `get_pr_diff` + `get_pr_timeline` + `list_pull_reviews`) a review used to start with. Every section is pre-sized to a shared budget with explicit `truncated`/`truncatedBy`/`bodyTruncated` markers, and the review-pull-request prompt now starts from the brief. Tool count: 29 → 30.
