---
'forgejo-toolkit': minor
---

**Your own AI endpoint, and one switch for the whole AI area.** The AI features no
longer depend on whatever language models your editor happens to offer. The settings
page has an **AI Endpoints** section where you describe an OpenAI-compatible server —
one on your own machine or a hosted gateway — with a display name and id, an address,
an authentication style (`Bearer`, an `api-key` header, or none), the models it
declares, and custom request headers. The API key and every header value live in the
editor's secret storage and are never written into settings, so the page says only
whether a value is set and clearing one is an explicit action; a blank id or display
name is generated from the address, a collision gets a suffix, and the page warns while
you create one that its id cannot change afterwards because the stored secrets are keyed
by it. Everything here is machine-scoped, so a workspace cannot point your requests at
an address of its own choosing. **Test connection** runs against one endpoint, reports
the address it used without the query string a secret could hide in, and treats a
server that has no model list as an answer rather than a failure.

Above all of it sits a single **Use AI features** switch, on by default: turn it off and
no AI feature runs and no model is asked for anything — neither your editor's chat
models nor a configured endpoint — while every control below it stays visible and
editable, because this page is the only place those values can be written. Each feature
keeps its own switch below it, off by default. Configuring an endpoint is itself the
statement that you intend to use it, so there is no second "allow requests to
configured endpoints" switch to find: delete the endpoint if you no longer want it.
A per-feature binding names an endpoint and a model for one feature, and every run
states in its panel, its diagnostics and the log which transport, endpoint, address and
model served it. The two ways of reaching a model never substitute for each other: an
endpoint that fails is reported as a failure and never quietly falls back to your
editor's models, or the other way round.

**The endpoint's model list is filled in for you.** Once you have typed an address and
a credential (or changed the authentication style) and stopped for about 800
milliseconds, the endpoint editor asks the endpoint for its model list and fills in only
the rows you have not written yourself — anything you typed stays as it is. One request
goes out per combination of address, authentication style and credential, further typing
cancels the pending one, only the model listing is ever requested (never a completion),
and nothing is written to your settings before you save. It sends nothing at all while
the global AI switch is off or for an address this extension cannot use. A probe that
gets no answer says so on the model rows and in the report card below them, and a probe
that answered also says that finding models is not permission to send content — the
global switch and each feature's own question are what decide that.

**Your AI endpoints travel with the rest of your configuration.** An export carries a
non-secret AI section — each endpoint's display name, address, authentication style,
declared models, the names of its custom headers, the per-feature bindings and the
transport choice — and importing it offers those endpoints in the same preview the
instance list already uses: a plain `http://` address is called out there rather than
only when a request is finally attempted, an id you already have is a choice between
keeping the configured endpoint, importing the file's alongside it under a new id, or
replacing it, and the preview states plainly whether the file carried any credentials.
The API key and every header value travel only when you encrypt the export, on the same
path as the instance tokens, and on the way back they are stored in the editor's secret
storage rather than in settings. Importing cannot turn anything on: it never writes the
global AI switch, never enables an AI feature, and never changes the transport you
chose, so the first run after an import still asks what may leave your machine. An
export written by an older version still imports, and an address this extension refuses
is refused in the preview rather than written.

**The AI area now follows your transport choice and leads with one default.** The model
transport is a choice on the settings page — `auto`, `vscode-lm` or
`openai-compatible` — because it decides which half of the AI area you are configuring:
`vscode-lm` shows your editor's chat-model row and hides the endpoint surface (with a
sentence saying so and which control brings it back), `openai-compatible` shows the
endpoint surface and hides the editor's model row, and `auto` shows both and states the
precedence. Below it, a **default endpoint and model** is the primary path: set it once
and every AI feature uses it. What used to be per-feature bindings are now per-feature
**overrides**, each defaulting to "do not override — follow the default above". Nothing
changes for an existing configuration, and a default that names an endpoint which is not
configured fails and names it instead of choosing another endpoint or inventing a model.

An AI pre-review against an endpoint that stopped at its own output limit now says that,
instead of only that the answer was not JSON: the message names the endpoint the way the
consent question does, says the answer hit the endpoint's output limit and could not be
read because of it, and offers the two ways out — raise the limit configured on the
endpoint, or choose a model that follows the instruction. It is said at most once per
run, and the diagnostics file records the same fact.
