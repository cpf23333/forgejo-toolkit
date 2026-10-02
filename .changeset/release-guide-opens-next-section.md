---
'forgejo-toolkit': patch
---

The release guide now opens the next `## [Unreleased]` section before the release
runs, in the same commit that names the released section for its version, instead
of leaving it for a step after the release. The changelog therefore always carries
a place for the next cycle, and nothing depends on a step that has to be
remembered once the artifact is out. The workflow's order (it prefers the section
that names the version and only falls back to the unreleased one) is what keeps
the empty heading above a released section harmless, and the dry run's line naming
the section it used stays a required check for that reason.
