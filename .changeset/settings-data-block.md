---
'forgejo-toolkit': patch
---

**Export and import moved to General → Settings and Data.** They used to sit in the
instances section, which read as "this exports your instances"; the file they write and
read is the whole configuration — the saved instances **and** the AI section (transport,
endpoints, the default endpoint and model, the per-feature bindings) — so they now live
in General, where the settings page keeps what belongs to the page itself rather than to
one subsystem. Nothing else about them moved: still one export entry rather than a split
pair, the same export dialog with its per-instance selection, the same import preview
with its per-item choices, tokens still stay in VS Code's SecretStorage, and an import
still never turns an AI feature or its egress on.
