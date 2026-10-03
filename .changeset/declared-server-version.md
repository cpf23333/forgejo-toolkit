---
'forgejo-toolkit': minor
---

Declare the Forgejo server version per instance. The version probe
(`GET /api/v1/version`) can be wrong or unavailable — a reverse proxy or path prefix
that blocks the endpoint, an unrecognised fork or version string, a timeout on an
unreachable instance, a renumbered upstream — and until now that silently took features
away, because the probe's answer is what gates them. The Settings form's instance
editor therefore has a **Server version** field: fill in what the instance actually runs
(`16.0.2` and `16.0.2+gitea-1.22.0` are both accepted, the same shapes the endpoint
returns) and that is what the extension believes; leave it empty and the automatic probe
is used exactly as before. The value is stored on the instance record beside the URL and
the URL-sync flag, so it is per instance, travels with export/import, and is not a VS
Code setting.

The resolution order now has one home (`resolveServerVersion`): **declared → probed →
unknown**. A declaration wins outright — it is read from the instance record rather than
from the probe cache, so the probe, the cache's 60-second TTL and the cross-window merge
write cannot overwrite, expire or displace it — and a declared instance is not probed at
all, which is the point when the endpoint is blocked or never answers. Every gate reads
that one resolution: with a version below the Actions floor the gated Actions features
are refused with a message that names your declaration rather than claiming "this server
reports", and a declaration below the supported floor raises the low-version notice with
the same attribution, so a declaration that is too low says so instead of leaving
features missing and unexplained. A value that cannot be a version is refused when you
save, with a readable message shown on the form — it is never stored and then silently
ignored. A wrong declaration still cannot break anything: whatever the server rejects
degrades through the existing error paths.

The polling diagnostics report where each instance's version came from: every row now
carries `source` (`declared`, `probed` or `unknown`), the declared string verbatim, and
the value the gates used, so a bug report says whether a feature was offered because of
your declaration or because of a probe.

The declaration also reaches the MCP server the Agents window (or any other host) starts
from a static `mcp.json`. That launch normally forwards into the extension host's broker,
where the record is available; with no window running it builds its own client, and until
now it probed regardless of what you had declared. The extension publishes each instance's
declaration in the instance registry it already writes for those launches
(`globalStorage/mcp-instances.json`), and the child installs it as the same reader the
editor uses, so its Actions gate follows **declared → probed → unknown** exactly as the
editor's does — a declared instance is not probed there either, and a version below the
Actions floor is refused with the message that names your declaration. The value is a
version string in an already credential-free file: no token, no new environment variable,
and no new secret channel. With no declaration the child probes as before, and a carried
value that cannot be a version is ignored rather than failing the launch.

The Settings field's own text names the shape rather than a number: the version example in
its description is the oldest release this build supports, taken from the same constant the
rest of the extension uses, and the field's placeholder is a `major.minor.patch` hint — so
neither the form nor the refusal that follows a bad value can keep naming an old release
after that floor moves.

That field arrives in a Settings surface that now separates the two things it was doing at
once. Adding and editing an instance used to be an inline form inside the instance list,
which left it unclear which instance was being edited and where the edit region began and
ended. The list is the master and the editor is the detail: **Edit** on a row (or **Add
Instance**) switches the Settings page to the instance editor, whose heading states the mode
and, when you are editing, the instance's name and URL, with the fields, the connection test
and the version declaration below it. Adding uses that same editor with nothing loaded, so
there is one place where an instance is configured rather than two. **Save** stores the
values and returns to the list with the outcome reported there; **Back to instance list** /
**Cancel Edit** returns without saving and asks first if you have typed anything, since that
is the point where unsaved input would be lost. Closing the editor also hands keyboard focus
back to the control the edit started from — the row's own **Edit** button, or **Add
Instance** for the add state — so a keyboard user is not dropped at the top of the document.
A saved instance whose row disappears (it was removed in another window) still closes its
editor instead of leaving buttons that answer "instance not found". Where the focus lands is
stated without a ring: the editor and the instance list take that focus programmatically so a
screen reader reads the heading the view opens on, but neither is a control, and a focus
outline drawn around the whole block read as a warning about the block rather than as "you are
here" — it was painted in the theme's focus colour, which a theme may keep for warnings. The
roots now paint no focus ring in any state (the browser's own ring is answered as well, not
just this rule), while the buttons and fields inside them keep the focus rings they draw
themselves, which is the signal a keyboard user needs. The shell's view container is the same
case and is treated the same way: every navigation moves focus into it so a screen reader
starts reading the view that just opened, and the browser drew its focus ring around that
container — the whole panel — on each of those moves. It paints none either, and the shell's
own back button, like every control inside the views, keeps its ring.

The editor's heading block is pinned to the top of the panel while you scroll through the
instance's fields, so the mode and the instance the fields belong to stay visible while the
version declaration at the bottom is being filled in. It is the one heading block that
sticks rather than a second summary line repeating the name: the editor keeps a single
heading, the name is stated once, and the opaque background keeps the fields from scrolling
through the pinned text. The panel also reserves the block's own height while scrolling a
field into view, so a field at the bottom of a short panel — the version declaration — is
never left underneath it: focusing or tabbing to a field stops it below the block, and the
reserved strip follows the block's real height rather than a fixed number, so the add form
(which states no URL) does not reserve the edit form's height. In a panel too short for that
to be enough the block drops to its compact form — the mode and the instance name stay, the
URL line and its copy control go until the panel is tall again — because that is what leaves
the field room when the scroll is already at its end.

The **Saved Instances** header wraps at the panel's narrowest widths instead of overflowing
it: the section heading and the **Add Instance** / **Export** / **Import** buttons now share
as many lines as they need, rather than the heading being squeezed to one character per line
beside buttons that cannot shrink. The same wrap applies to the two other rows of
fixed-width buttons on this page (the worktree cache-directory actions and the export
dialog's footer).

The controls on this page fit the sidebar instead of holding a fixed 320 px: the instance
URL, access token, server version and worktree cache-directory fields, and the language,
chat-model and worktree-mode selectors, now stretch to the column they sit in. At the
default sidebar width the fields were a pixel wider than that column, which was enough to
put a horizontal scrollbar on the page; at narrower widths they were far wider and the panel
scrolled sideways. The export dialog's checkbox rows do the same — each row takes the dialog's
width and its instance name and URL wrap, where before the row was as wide as the longest
URL inside it and both were clipped at a narrow width.

A saved instance or worktree row keeps stating which instance it is even when the two action
buttons cannot fit beside its name and URL. The text column now has a minimum width and the
buttons move to a line of their own in a narrow panel, where before the buttons were the only
part of the row with a hard minimum: they took the whole row — 142 px of a 143 px content box
at the narrowest sidebar — and the name and URL were drawn zero wide, leaving only **Edit**
and **Remove** visible. The instance's name is stated in full as well: it wraps instead of
being cut with an ellipsis, which at every panel width hid the one fact the row exists to show
(the default panel gives the name 151 px and the name itself is 172.7 px, so it was always
truncated; it takes two lines at the default width and at 200 px, one at 250 px). The URL and
the worktree row's cache path stay single lines with an ellipsis: a URL fits the column at
every width this panel is used at, and wrapping a machine path costs two lines on a row that
is meant to be scanned — measured at a 200 px panel, the worktree row grows from 131 px to
157 px if the path is allowed to wrap.

The notes and messages on this page wrap a long setting or command name instead of scrolling
the page sideways. A description that quotes an identifier, a status message that carries an
export path, and the empty-state text all break those runs at the panel's edge; prose still
wraps at its spaces, so nothing is broken mid-word that would otherwise fit. The AI
pre-review note's `forgejoToolkit.aiPreReviewChooseModel` was a single 195.6 px line box,
34.6 px past a 200 px panel's content edge, and the page carried a horizontal scrollbar
because of it.

The status strip that reports a connection test or a save is no longer drawn while it has
nothing to say. It is still rendered from the first paint and stays empty — that is what gives
an assistive technology a live region to announce the first message in — but an empty region
now takes no room and paints nothing, so the strip between the section header and the first
row is gone instead of reading as a stray rounded band or a loading placeholder. Both places
this page shows one — the Saved Instances section and the instance editor — behave the same
way.
