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
