---
'forgejo-toolkit': patch
---

The release guide now names the changelog section for the version being released
**before** the release workflow runs, instead of leaving the notes under
`## [Unreleased]` and renaming them afterwards. The workflow prefers the section
that names the version and only falls back to `## [Unreleased]`, so renaming
first turns the dry run's "found the section for this version" line into a real
check, and the record never calls an already-published version unreleased. The
post-release step now only opens a fresh `## [Unreleased]` section, re-checks the
version entries in the known-issues pair, and leaves the store wording alone
unless a store's status actually changed.