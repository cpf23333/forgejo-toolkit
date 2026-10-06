---
'forgejo-toolkit': patch
---

**The sidebar's refresh action re-reads the page you are on.** It used to refresh the
instance list wherever you were, so pressing it while reading a pull request, an issue or
a notification refreshed something you were not looking at. Each page now has its own
refresh whose tooltip says what it does — the dashboard's instances and repositories,
this repository, this issue, this pull request, or the notifications under the filters
on screen — and only one of them is ever present. Where refreshing would mean nothing the
icon is not offered at all: on the dashboard before the first instance is configured, and
on the global search page, whose own Search control is what re-runs its query.

Right-clicking a row, a card or a log line no longer shows the editor's cut/copy/paste
menu, which had nothing to act on there; fields and selected text keep it.

The first-run wizard no longer shows an empty strip under the buttons when it has nothing
to report — the message area stays invisible until it has something to say.
