---
'forgejo-toolkit': minor
---

**The settings page now covers the settings — and it is an editor tab of its own.**
Opening settings used to replace whatever you were reading in the sidebar, in a column
about 300 px wide, as eleven sections in one scroll with no navigation. It opens as an
editor-area tab now: the same **Open Settings** command and the same gear in the
sidebar view's title bar both open it, opening it again focuses the tab that is already
open rather than stacking a second one, closing it and opening it again gives you a page
that reads everything fresh, and opening it no longer touches the sidebar — the
sidebar's own copy of the page is gone, so there is exactly one place to change these
settings from. A tab that was hidden and becomes visible again re-reads what it shows
instead of returning with the snapshot it was holding.

The page is divided into six groups — **General**, **Instances**, **Notifications**,
**MCP**, **AI** and **Git / Worktree** — and opens on General. In a wide tab the groups
are a vertical list beside the content, with the group's name as the heading above it;
drag the tab narrow, or drop it into one pane of a split editor, and the same choice
moves into a selector in the sticky bar at the top, so the page always keeps a single
content column at that width. Neither shape is a setting: there is nothing new to
configure, the width decides. Switching groups only changes which group is on screen —
every control stays in the page, and the instance and AI-endpoint editors still return
you to the group you opened them from, with focus back on the row's own Edit button.

Nine settings that used to be reachable only through the editor's own settings user
interface are now presented where they belong: the notification polling switch, the
multi-window polling lease, the MCP server switch with its three write-tool gates and
the write-audit switch, and the AI pre-review switch with its prompt scope — the consent
value that decides how much an AI pre-review may send, which until then could neither be
seen nor changed from the page that owns the feature. Each one states its default in
words instead of prefilling it, and changing one writes only that setting; when the
editor refuses a write, the control goes back to the stored value and says what the host
answered. Two more settings followed: the **notification polling interval** is a number
field beside the polling switch (a whole number of seconds between 60 and 3600, default
300, refused with the range in the message while the interval already stored stays what
it was), and the **mock API switch** sits in a **Developer** passage at the end of
General and says plainly what it does — while it is on, every Forgejo request this
extension makes is answered from the build's own sample data, it is read once when the
extension starts so changing it takes effect after a window reload, and a production
build does not carry the mock at all. Nothing is left to the editor's own settings
editor now, except that the polling interval's section names it in place with an entry
point that opens the editor's settings filtered to this extension. The page also still
writes only your user level, and it now **says when a workspace setting is the value you
are looking at**: such a control carries that level's name as a small badge and one
sentence saying the workspace value wins here and that changing the control on this page
will not take effect, next to the **Open Extension Settings** action the page header
offers. With nothing overriding a control, nothing is shown; a workspace _folder_ value
is deliberately not named, because this configuration is read without a resource URI,
where VS Code never reports one.

**The import preview has a way back.** Its own heading now carries a **Back to the
instance list** link — the same kind of return path the instance and endpoint editors
already offer at the top of their headings — which puts you back on the settings list,
in the group you opened the preview from, with focus on the Import button again. The
heading and the Cancel/Import pair no longer scroll away with a long file, and if you
changed which instances are selected or answered an endpoint's conflict question, the
link asks before leaving instead of discarding your choices silently.
