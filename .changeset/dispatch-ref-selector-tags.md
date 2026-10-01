---
'forgejo-toolkit': patch
---

The "run a workflow" form's ref field is labelled branch/tag, but only branches
ever reached it, so a workflow could not be dispatched against a tag. It now
offers both kinds, taken from the refs request the repository browser already
makes for its own branch/tag lists (the same `getRepoRefs` host path, so no
endpoint was added), and each option names its kind — `Branch: main`,
`Tag: v0.0.1` — the way the Issue/PR form's ref selector already does. The value
sent to the dispatch is still the plain ref name. Until that request answers
(or if it fails) the repository detail's branch list stands in, exactly as
before; the field still starts on the repository's default branch, a ref you
chose survives the lists being loaded again, and the selector filters fuzzily
like the repository's branch pickers.
