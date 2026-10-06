---
'forgejo-toolkit': minor
---

**Draft a pull request description from the comparison you are working on — diff
included.** The **Generate description** control above the description field lives on
the create-pull-request form and in an existing pull request's edit dialog: a chat model
reads the commits between the two branches — their subjects, bodies, authors and dates —
and the path and status of every changed file, and writes a description into the field
as an **editable** draft. You still create or save the pull request yourself: the
extension never opens, fills in or submits it, a draft that could not be produced leaves
the field exactly as you wrote it and says why, and a field you have already written in
is only replaced after you press the control a second time. Off by default, and
separately from the AI pre-review; while it is off the control is not shown and nothing
is read or sent.

What else may be sent is your own decision, recorded in
`forgejoToolkit.prDescriptionPromptScope`: `commits-only` sends the branch names, your
typed title and the commits and changed-file list with no file content at all;
`commits-and-files` adds the text of the changed files at the head branch; and
`commits-and-diff` adds the pull request's own diff exactly as the server reports it —
the added and removed lines with their file and hunk headers — so the model reads what
actually changed rather than only what the commit messages say. That last scope reads
the pull request's own diff, so it is offered in an existing pull request's edit dialog
and not on the create form, whose pull request does not exist yet: with it configured
the create form does not show the control, and a run started from there anyway refuses
by name instead of using another scope. Binary changes are never requested as binary, so
a binary file's change is sent as the server writes it, without hunks, and the prompt
says so. The diff is cut from the end when the shared diff budget or its file cap is
reached, and every cut is stated in the prompt itself; the two scopes that shipped keep
byte-for-byte the same prompt.

The default `ask` means the first draft shows one modal naming the provider that would
receive the content and what each answer sends — nothing is requested, sent or written
before you answer, and your answer is stored there so you are asked once. The model
comes from the same place the AI pre-review takes its own: your editor's models, chosen
in a picker at the moment you generate because this feature stores no model of its own,
or a configured endpoint bound to `prDescription`. A failure is reported and never
retried on another model or the other transport, and with no usable model at all the
action sends nothing and points at the Settings page, which explains the two ways out.
