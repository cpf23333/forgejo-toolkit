---
'forgejo-toolkit': patch
---

**The import preview no longer calls a plaintext file encrypted.** The credentials line
asked whether the file carried a `secrets` block, and a hand-written or hostile plaintext
file can carry one: such a file was described as "this encrypted file carries the
credentials for its N endpoints" even though nothing about it was encrypted — and import
is exactly where a file from elsewhere enters. The sentence now follows the file's own
encryption flag, which the host reports and the preview carries through its message
handler to the view, so a plaintext file that still carries credentials is described as
one, and an encrypted file that carries none no longer claims it was not encrypted.
Nothing else about import changed: the credentials go to the editor's secret storage
either way, the per-item choices and conflict answers are as they were, and importing
still turns no AI switch and no egress on. The preview also now says in its own words
that importing never changes your model transport setting, which is what it always did.
