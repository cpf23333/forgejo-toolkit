---
'forgejo-toolkit': minor
---

The "run a workflow" form now asks for the inputs a workflow actually declares
instead of an empty key/value editor. The extension host reads
`on.workflow_dispatch.inputs` out of the workflow file at the ref the form has
selected — searching `.forgejo/workflows`, then `.gitea/workflows`, then
`.github/workflows`, exactly the paths Forgejo reads — parses it there (the
webview bundle gained no YAML parser; `yaml` 2.9.1, ISC, is a runtime dependency
of `packages/forgejo-toolkit` and was already in the production dependency graph
through a transitive dependency, so no new license enters `pnpm licenses list
--prod`), and sends one descriptor per input to the form over the existing
message layer (`getWorkflowDispatchInputs` → `workflowDispatchInputs`).

The form renders a text field for `string`, a checkbox for `boolean` and a
dropdown built from `options` for `choice`; any other declared type (`number`,
`environment`, a type a newer Forgejo adds) becomes a text field rather than a
broken control. Each control carries the input's name — Forgejo's own form shows
only the description — plus the description as help text, a marker for
`required`, and the declared `default` prefilled; an empty `required` input
blocks the submit.

A workflow whose file cannot be fetched or parsed (a private path, an
unsupported shape, no `inputs:` block, an API error) still dispatches: the raw
key/value editor stays as the fallback, and the form says which mode it is in and
why. Values the user typed are never dropped when the form switches between the
two — a raw row whose key a declaration names becomes that field's value, and a
typed value whose input the next selection no longer declares becomes a raw row.
