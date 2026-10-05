export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
  syncApiUrlsToInstanceUrl?: boolean;
  /**
   * The Forgejo version the user declared for this instance (`16.0.2`,
   * `16.0.2+gitea-1.22.0`), or absent when the instance uses the automatic
   * probe.
   *
   * It is the escape hatch for a probe that cannot see the truth: a reverse
   * proxy or path prefix that blocks `/api/v1/version`, an unrecognised fork or
   * version string, a timeout on an unreachable instance, a renumbered
   * upstream. A declaration wins over the probe and the shared cache
   * (`resolveServerVersion` in `api/serverVersion.ts` states the order), and it
   * is validated with `parseServerVersion` on every write, so a stored value
   * always parses.
   */
  declaredServerVersion?: string;
}

/**
 * Instance data as exposed to webviews. The access token never leaves the
 * extension host: every API call is proxied through host message handlers,
 * so webviews only receive the non-sensitive fields.
 */
export type PublicForgejoInstance = Omit<ForgejoInstance, 'token'> & {
  /** An opaque fingerprint of the token, so a webview can notice a swap. */
  tokenFingerprint?: string;
  /**
   * The same instance URL with its credential material *removed* rather than
   * masked, for a URL the webview navigates to or copies (a clone URL, an
   * "open in browser" link, the token-settings page).
   *
   * `url` above is the display value: it keeps `***` where a credential was, so
   * it must never be pasted into git or opened. This field carries the plain
   * URL for everything functional, so the two cannot be confused at a call site.
   */
  functionalUrl: string;
};

/**
 * A short, non-reversible fingerprint of an access token.
 *
 * The webview must be able to tell that the credential behind an instance
 * changed (so it can drop cached payloads) without ever seeing the token. A
 * plain hash is used on purpose: `node:crypto` must not reach the webview
 * bundle, and the value never has to be collision-proof against an attacker who
 * already has the token.
 */
function tokenFingerprint(token: string): string {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(index)) | 0;
  }
  return `${(hash >>> 0).toString(16)}-${token.length}`;
}

/**
 * A URL with its credential material removed, for anything that leaves the
 * extension host (the webview, a toast, the MCP server label).
 *
 * A configured instance URL may embed credentials (`https://user:token@host`),
 * and the webview is a sandboxed page that must never receive them. The rule
 * mirrors `redactUrlUserinfo` in the extension package (kept separate because
 * the webview bundle imports this module and must stay free of the host's
 * module graph): a password is replaced, and so is the username of an http(s)
 * URL that carries no password, where a Forgejo access token is commonly written
 * in the username position. Host and path stay readable.
 */
function redactUserinfo(url: string): string {
  if (!url.includes('@')) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: the scp-like `user@host:path` form carries no
    // password, so there is nothing to strip.
    return url;
  }
  if (!parsed.username && !parsed.password) {
    return url;
  }
  if (parsed.password) {
    parsed.password = '***';
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    parsed.username = '***';
  }
  return parsed.toString();
}

/**
 * A URL with its credential material removed *entirely*, for a URL the webview
 * hands to git or opens in a browser.
 *
 * This mirrors `stripUrlUserinfo` in the extension host's
 * `utils/redactUrlUserinfo.ts` (kept separate for the same reason as
 * `redactUserinfo` above: this module reaches the webview bundle). Masking is
 * only ever right for a value a human reads: `https://***@host/owner/repo.git`
 * is not a URL git can clone, and `https://***@host/user/settings/applications`
 * is not a page a browser can open.
 *
 * Exported because the webview's instance *forms* build a functional URL from
 * what the user typed (the token-settings link), where there is no
 * `PublicForgejoInstance` to read `functionalUrl` from.
 *
 * Only ever call this on http(s) instance URLs. It must not be reused for git
 * remotes: an `ssh://` remote's userinfo is the login name, and stripping it
 * would silently re-target the remote (`ssh://git@host/...` → `ssh://host/...`).
 */
export function stripUserinfo(url: string): string {
  if (!url.includes('@')) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: the scp-like `user@host:path` form is a clone URL
    // whose userinfo is a login, not a secret, and it is returned as given.
    return url;
  }
  if (!parsed.username && !parsed.password) {
    return url;
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

/**
 * An instance entry as sent to the webview in the `importInstancesPreview`
 * reply: every field of `ForgejoInstance` except `token`.
 *
 * The import file's tokens stay in the extension host — stashed on preview and
 * rehydrated by id when the import is confirmed — so the preview payload must
 * never carry one. `token?: never` makes that exclusion structural instead of
 * a sender-side convention (the same defense-in-depth idea as
 * `PublicForgejoInstance`/`toPublicInstance` above): an entry that still holds
 * a token fails to type-check at the reply's construction site instead of
 * leaking silently the day an edit forgets to strip it. The property is
 * declared optional rather than omitted so a token-less
 * `Omit<ForgejoInstance, 'token'>` object stays assignable to it.
 */
export type ImportPreviewInstance = Omit<ForgejoInstance, 'token'> & {
  /** Never present: token values never cross into the webview process. */
  token?: never;
};

export function toPublicInstance(instance: ForgejoInstance): PublicForgejoInstance {
  return {
    id: instance.id,
    // Never the raw stored URL: it may carry the token as userinfo, and every
    // webview renders this value (the dashboard list, the Settings editor).
    url: redactUserinfo(instance.url),
    // The functional twin: the same URL with the credential dropped, for the
    // links and clone URLs the webview uses (see PublicForgejoInstance).
    functionalUrl: stripUserinfo(instance.url),
    name: instance.name,
    username: instance.username,
    tokenFingerprint: tokenFingerprint(instance.token),
    ...(instance.syncApiUrlsToInstanceUrl !== undefined
      ? { syncApiUrlsToInstanceUrl: instance.syncApiUrlsToInstanceUrl }
      : {}),
    // Not a secret and not credential material: the Settings form is where the
    // declaration is edited, so the webview has to receive it to prefill the
    // field (a payload from an older host build simply carries none).
    ...(instance.declaredServerVersion !== undefined ? { declaredServerVersion: instance.declaredServerVersion } : {}),
  };
}

export interface ExportSettings {
  // Only the locales the extension actually ships (see the
  // `forgejoToolkit.locale` enum); anything else would render as a raw i18n key
  // in the import preview and would be dropped by the host on apply.
  locale?: 'en' | 'zh';
  debug?: boolean;
  worktreeOpenMode?: 'ask' | 'currentWindow' | 'newWindow';
  worktreeCacheDirectory?: string;
}

/**
 * One configured AI endpoint as the `version: 3` export writes it
 * (`docs/design/ai-model-transport.md` §10.1).
 *
 * This is the **non-secret** half of a provider, and it is the whole of what an
 * unencrypted export carries: the id, display name, base URL, declared models,
 * authentication style, the declared header **names** (each with the
 * `valueSecret: true` marker §10.2 keeps, so a receiver is told a value exists
 * without being given it) and the per-endpoint local-only promise. The API key and
 * every header value are in {@link ExportAiSecrets} instead, which only the
 * encrypted wrapper holds.
 */
export interface ExportAiProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  auth: AiProviderAuthValue;
  headers: Array<{ name: string; valueSecret: true }>;
  localOnly: boolean;
}

/**
 * The credentials an **encrypted** export carries (§10.2), keyed the way
 * `SecretStorage` keys them: one API key per provider id, one value per
 * provider id and header name.
 *
 * The split is by kind of data rather than by field name, which is the same rule
 * §8.2 applies to the settings themselves: request headers routinely *are* the
 * credential, so a custom header's value is protected exactly like the API key.
 */
export interface ExportAiSecrets {
  keys: Record<string, string>;
  headerValues: Record<string, Record<string, string>>;
}

/**
 * The `ai` section of an export payload (§10.1).
 *
 * The keys that decide **whether content may leave the machine** are deliberately
 * absent — `aiProvidersEnabled`, `aiPreReview` and `aiPreReviewPromptScope` — so
 * that importing a file can never change another machine's egress posture (§7.4).
 * `transport` travels as information the preview shows; the host does not apply it
 * (§10.3's rule 1), because on the receiving machine the opposite value may be a
 * working setup.
 */
export interface ExportAiConfig {
  providers: ExportAiProvider[];
  bindings: Array<{ feature: string; providerId: string; modelId: string }>;
  transport: 'auto' | 'vscode-lm' | 'openai-compatible';
  localOnly: boolean;
}

/**
 * One provider as the import preview shows it.
 *
 * No secret travels here, and none could: a header is rendered by its **name**, and
 * whether a value was stored is answered once for the whole file by
 * `secretsIncluded` rather than per provider, because that is the fact §10.2 has to
 * state plainly — an unencrypted export contains no key and no header value at all.
 */
export interface AiImportPreviewProvider {
  id: string;
  name: string;
  baseUrl: string;
  auth: AiProviderAuthValue;
  /** The declared model ids: a receiver wants the list, not each entry's display name. */
  models: string[];
  /** The declared header **names**, never a value (§8.2). */
  headers: string[];
  localOnly: boolean;
  /** An endpoint with this id is already configured, so the import needs a decision. */
  existing: boolean;
  /** The address is plain `http://`: flagged in the preview, not only at run time (§10.3). */
  insecure?: boolean;
  /**
   * The reason the settings editor's own validation refuses this entry, when it
   * does. The entry is shown so the user can see what the file declared, but it is
   * never written: an address the editor refuses must not become a destination by
   * being imported.
   */
  unusable?: string;
}

/**
 * How an imported provider whose id is already configured is resolved.
 *
 * The same three answers the instance preview offers:
 * - `rename` — the entry is written under a collision-free sibling id;
 * - `keep` — the stored entry stays and the file's entry is not written;
 * - `replace` — the file's entry overwrites the stored one.
 *
 * Absent means `keep`, the direction that changes nothing on the receiving machine.
 */
export type ImportAiConflictStrategy = 'rename' | 'replace' | 'keep';

export interface LinkedRepository {
  instanceId: string;
  owner: string;
  repo: string;
  localPath: string;
  remoteUrl: string;
}

/**
 * One chat model the editor offers, as the Settings page has to show it.
 *
 * The five fields are the ones a chooser needs to be unambiguous — the display
 * `name`, the `vendor`/`family` pair two providers can share, the opaque `id`,
 * and the `maxInputTokens` budget — because the list only exists at runtime
 * (`vscode.lm.selectChatModels()`), which is exactly why the manifest's setting
 * cannot be a dropdown and the choice needs a UI of its own.
 */
export interface AiPreReviewChatModelOption {
  name: string;
  vendor: string;
  family: string;
  id: string;
  maxInputTokens: number;
  /**
   * The value `forgejoToolkit.aiPreReviewModel` stores for this model, in the
   * `vendor/family` (or `vendor/id`) form that setting accepts, or absent when
   * no accepted form can name the model. A chooser must not offer a model
   * without one: the value it wrote would match nothing on the next run, which
   * is the silent substitution the setting exists to prevent.
   */
  value?: string;
}

/**
 * How one configured AI endpoint authenticates a request
 * (`docs/design/ai-model-transport.md` §8.5), spelled exactly like the
 * `forgejoToolkit.aiProviders[].auth` values the reader accepts.
 */
export type AiProviderAuthValue = 'bearer' | 'api-key-header' | 'none';

/**
 * One model a configured endpoint declares, as the settings page edits it.
 *
 * The declaration is not a whitelist (§8.1): the model id is free text, and the
 * endpoint's own `/models` only prefills this list.
 */
export interface AiProviderModelDraft {
  id: string;
  name: string;
}

/**
 * One custom header of a configured endpoint, as the settings page may see it.
 *
 * The **name** is what settings hold; `set` is whether a value is stored in the
 * editor's secret storage, and the value itself never travels to the webview
 * (§8.2). `shadowed` is the conflict §8.5 requires the page to name: the `auth`
 * style owns this name, so the declared header is not sent.
 */
export interface AiProviderHeaderReading {
  name: string;
  set: boolean;
  shadowed: boolean;
  /** `api-version` travels as a query parameter rather than as a header (§6.2). */
  queryCarried: boolean;
}

/** One configured endpoint as the settings page sees it: configuration plus what is stored. */
export interface AiProviderEditorEntry {
  id: string;
  name: string;
  baseUrl: string;
  models: AiProviderModelDraft[];
  auth: AiProviderAuthValue;
  headers: AiProviderHeaderReading[];
  localOnly: boolean;
  /** Whether an API key is stored. `auth: 'none'` needs none, so this stays `false` there. */
  keySet: boolean;
  /** The base address as a human may see it: no query string, no userinfo. */
  address: string;
  /** Set when the configured address cannot be a model endpoint at all (§6.2). */
  addressError?: string;
  /** Set when the address is plain `http://`, which is allowed but reported (§6.2). */
  insecure: boolean;
  /** Set when the local-only policy refuses this address, so nothing may be sent to it (§8.8). */
  localOnlyBlocked: boolean;
}

/** One per-feature binding, as the settings page edits it. */
export interface AiModelBindingDraft {
  feature: string;
  providerId: string;
  modelId: string;
}

/**
 * The default endpoint-and-model pair, as the settings page edits it
 * (`docs/design/ai-model-transport.md` §8.4).
 *
 * It is the same statement a binding makes, made once for every feature that has
 * no override of its own — which is why it carries no `feature` field. Empty
 * strings mean "there is no default", and the host refuses a half-configured pair
 * rather than guessing the missing half.
 */
export interface AiDefaultModelDraft {
  providerId: string;
  modelId: string;
}

/** One configured entry the settings reader could not read, so the page can name what was ignored. */
export interface AiProviderRejection {
  index: number;
  reason: string;
  /** The raw entry's `id` when it had a string one; absent when the entry could not name itself. */
  id?: string;
}

/**
 * Everything the provider section of the settings page renders, in one reply.
 *
 * One message rather than a handful, because the surface they describe is one
 * screen and the parts constrain each other: whether the egress switch is on,
 * what the transport says, which endpoints exist and which of their secrets are
 * stored are read together so the page can never show a state that was never
 * true. The default destination and the per-feature overrides travel together for
 * the same reason — the page has to be able to say that an override sits on top
 * of a default — and `capability` is the §9.3 answer for the one AI feature this
 * build has, with `selection` naming the path that answer came from. The
 * `capability` discriminator is what the "no usable model" block branches on.
 */
export interface AiProviderSettingsSnapshot {
  providers: AiProviderEditorEntry[];
  rejected: AiProviderRejection[];
  /** `forgejoToolkit.aiProvidersEnabled`: the second, independent egress gate (§8.3). */
  enabled: boolean;
  transport: 'auto' | 'vscode-lm' | 'openai-compatible';
  /** `forgejoToolkit.aiLocalOnly`: refuse endpoints that are not on this machine or a private network. */
  localOnly: boolean;
  requestTimeoutMs: number;
  bindings: AiModelBindingDraft[];
  /**
   * The default destination every feature without an override of its own follows
   * (`forgejoToolkit.aiDefaultProvider` / `forgejoToolkit.aiDefaultModel`).
   *
   * Both empty is the "no default configured" state, which is what a fresh
   * install and every configuration written before this pair existed report.
   */
  defaultModel: AiDefaultModelDraft;
  /** The features a binding may name; one today, and the page renders only what it is given. */
  features: string[];
  /**
   * Which path the current `capability` answer came from, so the page can say what
   * a request would actually use right now in one sentence per transport choice.
   * `none` accompanies an unavailable answer and names no path, because none was
   * selected.
   */
  selection: 'editor' | 'configured-endpoint' | 'none';
  /**
   * Whether any model is usable right now, and — when it is not — the reason
   * code plus the sentence explaining it. This is `selectedModelFor`'s own
   * answer, so the block and the run cannot disagree about why nothing is
   * available.
   */
  capability: { available: true } | { available: false; code: string; reason: string };
}

/**
 * What one "test connection" probe found (`docs/design/ai-model-transport.md` §8.7).
 *
 * `address` is where the request went, rendered without its query string and
 * without credentials; `shadowed` names the declared headers the `auth` style
 * suppressed. A credential is never part of this shape.
 */
export interface AiProviderTestReport {
  providerId: string;
  providerName: string;
  address: string;
  ok: boolean;
  /** `false` when validation refused locally: nothing was sent at all. */
  ran: boolean;
  status?: number;
  elapsedMs?: number;
  summary?: string;
  reason?: string;
  /**
   * The model ids `GET <base>/models` reported, when it answered with a list.
   *
   * The record's §8.7 step 2 uses this list to **prefill** the editor's model
   * declaration: the declaration is not a whitelist (§8.1), so the prefilled ids are
   * ordinary rows the user can edit or drop. Absent when no model list was read
   * (the endpoint has none, or the request failed before answering one).
   */
  models?: string[];
  shadowed: string[];
}

/**
 * One probe of an endpoint the editor has **not saved**
 * (`docs/design/settings-page.md` §4.2).
 *
 * The settings page's automatic model probe runs on a draft: the fields the user
 * has typed, not a stored endpoint. The host builds a temporary
 * `AiProviderConfig` from this payload and never writes any of it — the `key` and
 * the header values below are held in memory for the one request and are never
 * stored in settings or in secret storage by this path. `id` and `name` are only
 * what the report says the probe was about.
 */
export interface AiProviderDraftProbe {
  id: string;
  name: string;
  baseUrl: string;
  auth: AiProviderAuthValue;
  /** The editor's own local-only promise, which gates the probe like the setting does. */
  localOnly: boolean;
  /** The API key typed in this session; empty means "there is none to send". */
  key: string;
  /** The header values typed in this session, by declared name. */
  headers: Array<{ name: string; value: string }>;
}

/**
 * The five values of `forgejoToolkit.aiPreReviewPromptScope`, in the order the
 * manifest's dropdown and the settings page's own dropdown both show them.
 *
 * Shared rather than declared twice: the settings record's §3.2 requires the
 * page's dropdown to come from the same enumeration the host reads and writes, so
 * a value the page cannot render and a value the host cannot store cannot drift
 * apart. `ask` is first because it is the default and the only value that sends
 * nothing on its own — it is the question, not an answer.
 */
export const AI_PRE_REVIEW_PROMPT_SCOPES = [
  'ask',
  'metadata-only',
  'changed-lines-only',
  'full-diff',
  'changed-files',
] as const;

/** One value of `forgejoToolkit.aiPreReviewPromptScope`. */
export type AiPreReviewPromptScopeValue = (typeof AI_PRE_REVIEW_PROMPT_SCOPES)[number];

/**
 * The three values of `forgejoToolkit.prDescriptionPromptScope`, in the order the
 * manifest's dropdown, the settings page's dropdown and the consent modal show
 * them (`docs/design/ai-model-transport.md` §7.6).
 *
 * A second enumeration rather than a reuse of the pre-review's five: the two
 * features send different content at different moments, so the pre-review's names
 * would promise something else here (the record's §7.6 states the decision, and
 * `src/prDescriptionSettings.ts` is the reader). `ask` is first because it is the
 * default and the only value that sends nothing on its own.
 */
export const PR_DESCRIPTION_PROMPT_SCOPES = ['ask', 'commits-only', 'commits-and-files'] as const;

/** One value of `forgejoToolkit.prDescriptionPromptScope`. */
export type PrDescriptionPromptScopeValue = (typeof PR_DESCRIPTION_PROMPT_SCOPES)[number];

/**
 * The three values of `forgejoToolkit.aiTransport`, in the order the manifest's
 * dropdown and the settings page's own dropdown both show them
 * (`docs/design/ai-model-transport.md` §8.4).
 *
 * Shared rather than declared twice: since the settings page renders the transport
 * as a control of its own, the page's dropdown has to come from the same
 * enumeration the host reads and writes, so a value the page cannot render and a
 * value the host cannot store cannot drift apart. `auto` is first because it is
 * the default and the only value that decides anything at run time — the other two
 * are instructions to use one route and to fail rather than fall back to the other.
 */
export const AI_TRANSPORT_CHOICES = ['auto', 'vscode-lm', 'openai-compatible'] as const;

/** One value of `forgejoToolkit.aiTransport`. */
export type AiTransportChoiceValue = (typeof AI_TRANSPORT_CHOICES)[number];

/**
 * The settings this extension's own settings page renders with a control of its
 * own, spelled as the full setting ids the manifest contributes.
 *
 * It is the **writable** half of the page's ownership policy
 * (`docs/design/settings-page.md` §1.3, §3.2): the host accepts a write for one of
 * these keys from the page and refuses every other key, and the drift guard
 * (`src/__tests__/settingsSurface.test.ts`) holds the same list — read from the
 * webview's English string catalogue — against the manifest. A setting that is
 * not here is native-only, and `NATIVE_ONLY_SETTINGS` in
 * `src/webview/settingsSurface.ts` is where its reason lives.
 */
export const SETTINGS_SURFACE_WRITABLE_KEYS = [
  'forgejoToolkit.notificationPollingEnabled',
  'forgejoToolkit.mcpEnabled',
  'forgejoToolkit.mcpWriteTools.createIssueComment',
  'forgejoToolkit.mcpWriteTools.submitPullReview',
  'forgejoToolkit.mcpWriteTools.cancelActionRun',
  'forgejoToolkit.mcpWriteAuditToFile',
  'forgejoToolkit.multiWindowLease',
  'forgejoToolkit.aiPreReview',
  'forgejoToolkit.aiPreReviewPromptScope',
  'forgejoToolkit.prDescription',
  'forgejoToolkit.prDescriptionPromptScope',
] as const;

/** One setting the settings page may write. */
export type SettingsSurfaceWritableKey = (typeof SETTINGS_SURFACE_WRITABLE_KEYS)[number];

/**
 * The settings the page's own sections present, as the host last read them
 * (`docs/design/settings-page.md` §3.2).
 *
 * One message rather than one per setting, for the reason the AI endpoint
 * snapshot gives: the page renders a screen, and every control on it has to be
 * showing the host's own reading rather than a value the page remembered. The
 * values are the **effective** ones (`getConfiguration` resolves workspace over
 * user over default), which is what the user is actually living with.
 */
export interface SettingsSurfaceSnapshot {
  /** `forgejoToolkit.notificationPollingEnabled` (default on). */
  notificationPollingEnabled: boolean;
  /** `forgejoToolkit.mcpEnabled` (default on). */
  mcpEnabled: boolean;
  /** The three per-tool write gates, each off by default. */
  mcpWriteTools: {
    createIssueComment: boolean;
    submitPullReview: boolean;
    cancelActionRun: boolean;
  };
  /** `forgejoToolkit.mcpWriteAuditToFile` (default off). */
  mcpWriteAuditToFile: boolean;
  /** `forgejoToolkit.multiWindowLease` (default on). */
  multiWindowLease: boolean;
  /** `forgejoToolkit.aiPreReview` (default off). */
  aiPreReview: boolean;
  /** `forgejoToolkit.aiPreReviewPromptScope`, read exactly as the run reads it. */
  aiPreReviewPromptScope: AiPreReviewPromptScopeValue;
  /** `forgejoToolkit.prDescription` (default off). */
  prDescription: boolean;
  /** `forgejoToolkit.prDescriptionPromptScope`, read exactly as the run reads it. */
  prDescriptionPromptScope: PrDescriptionPromptScopeValue;
}

/** Events accepted by the Forgejo API when submitting a pending pull review. */
export type PullReviewSubmitEvent = 'COMMENT' | 'APPROVED' | 'REQUEST_CHANGES';

/**
 * The prompt scope one run actually used, as the panel's header reports it.
 *
 * Spelled exactly like the setting's values (`forgejoToolkit.aiPreReviewPromptScope`)
 * because the header's job is to say what that run sent, and the value a user can
 * look up in the Settings UI is the honest way to name it. `ask` is deliberately
 * absent: a run never starts under it.
 */
export type AiPreReviewPanelScope = 'metadata-only' | 'changed-lines-only' | 'full-diff' | 'changed-files';

/** What one candidate's "open the diff" link needs, or `undefined` when it cannot be opened. */
export interface AiPreReviewPanelDiffTarget {
  /** The changed file's status, which decides whether the base path is its old name. */
  status?: string;
  /** The path the file had at the base commit, for a renamed file. */
  previousPath?: string;
  /** The pull request's base sha; the link is hidden when either sha is missing. */
  baseSha?: string;
  headSha?: string;
}

/**
 * One proposed comment as the AI pre-review panel shows it.
 *
 * `index` is the card's identity. The anchor fields (`path`, `line`, `side`,
 * `extraLines`) and `diff` are the host's own: they are rendered and never read
 * back from the webview, so a forged message cannot move a comment to another
 * file, line or side.
 *
 * `body` is the model's text, which the panel pre-fills its editor with. Unlike
 * the anchor it **is** echoed back — in {@link AiPreReviewPanelSelectedBody} —
 * because the user may edit it before the draft is created (2026-10-02), and the
 * host re-validates whatever comes back before it writes anything.
 */
export interface AiPreReviewPanelCandidate {
  index: number;
  path: string;
  /** 1-based line in the file on `side`. */
  line: number;
  side: 'head' | 'base';
  /** Extra lines the comment covers after `line`; `0` means a single line. */
  extraLines: number;
  /** The full comment body — the reason this panel replaced the quick pick. */
  body: string;
  /** Whether the body was cut to the shared per-comment cap. */
  bodyTruncated?: boolean;
  /** Where the anchor is, for the card's "open the diff" link. */
  diff?: AiPreReviewPanelDiffTarget;
}

/**
 * One card the panel's answer names, and the body to create it from.
 *
 * `index` must be one of the payload's own candidate indexes; `body` is the text
 * the user left in that card's editor, which may be the model's wording or their
 * own. The panel's answer must not be trusted for anything else: paths, lines,
 * sides and shas never travel in it at all, so the host takes them from its own
 * copy of the payload and only this body replaces anything.
 */
export interface AiPreReviewPanelSelectedBody {
  index: number;
  body: string;
}

/** One drop reason and how many candidates it accounts for, already localized. */
export interface AiPreReviewPanelDrop {
  /** The localized reason, from the same catalog the run's own report uses. */
  label: string;
  count: number;
}

/**
 * Which transport served one run, and where it sent the content.
 *
 * Three facts, in the order a reader needs them: the seam's own identifier
 * (`'vscode.lm'` or `'openai-compatible:<providerId>'`), which of the two branches
 * that is (so a reader does not have to parse the id), and the party that received
 * the content — the editor's model vendor, or a configured endpoint's display name
 * together with its address. `address` is absent for the editor's own models: there
 * is no address this extension may promise for them, and the consent question says
 * the same by leaving its address clause out.
 */
export interface AiPreReviewPanelTransport {
  /** The seam's stable identifier: `'vscode.lm'` or `'openai-compatible:<providerId>'`. */
  id: string;
  /** Which branch of the seam served the run. */
  kind: 'vscode.lm' | 'openai-compatible';
  /** The party that received the content: the model's vendor, or the endpoint's display name. */
  provider: string;
  /** The configured endpoint's display address; absent for the editor's own models. */
  address?: string;
}

/**
 * Everything the panel's header states about the run that produced the cards.
 *
 * This is the transparency the quick pick could not give: the pull request, which
 * transport and provider served the run and with which model (so the privacy point
 * stays on screen and an odd answer can be traced to where it came from), the prompt
 * scope the run actually used, the coverage of the whole-pull-request run, and both
 * counts — how many candidates survived validation and how many were dropped, by
 * reason.
 */
export interface AiPreReviewPanelPayload {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  /** The pull request's title, when the server gave one. */
  pullRequestTitle?: string;
  model: {
    name: string;
    vendor: string;
    family: string;
    id: string;
  };
  /**
   * Which **transport**, **provider** and endpoint address served the run
   * (`docs/design/ai-model-transport.md` §11.3).
   *
   * The model name alone no longer answers "where did my content go?": the same
   * model name can arrive from the editor's own provider list or from a configured
   * OpenAI-compatible endpoint, and only this block says which of the two — and,
   * for an endpoint, the address the request actually went to. It is always
   * present, because every run is served by exactly one transport; the panel
   * exists to be the surface where that is visible.
   */
  transport: AiPreReviewPanelTransport;
  scope: AiPreReviewPanelScope;
  /**
   * How many changed files this run actually covered, which is what makes the
   * panel's "this run covers the whole pull request" line observable.
   *
   * It is the brief's own file count — the files the run read and whose diff
   * supplied the line tables every anchor was validated against. The header
   * states it unconditionally, because a run always assembles a brief before it
   * asks anyone anything; a coverage count that could be absent would let the one
   * line that names the scope disappear silently.
   */
  changedFileCount: number;
  /**
   * How many changed files the run fetched; `changedFileCount` is how many of
   * them it actually covered.
   *
   * The two differ exactly when the brief's table was cut short (the row cap, the
   * path budget or the client's own page cap), and that is the one case where
   * "this run covered the whole pull request" would be a false claim — so the
   * header says "N of M" instead. Both numbers come from the same run as the
   * cards; neither is a second read of the pull request, which could see a
   * different head.
   */
  changedFilesTotal: number;
  /** How many candidates survived validation. */
  candidateCount: number;
  /** The dropped ones, grouped by reason; empty when nothing was dropped. */
  drops: AiPreReviewPanelDrop[];
  candidates: AiPreReviewPanelCandidate[];
}

export type HostToWebviewMessage =
  | { command: 'instances'; data: PublicForgejoInstance[] }
  // Sent by the "refresh instances" command: the webview should drop its
  // instance-level TTL caches and reload the dashboard lists.
  | { command: 'refreshData' }
  | {
      command: 'initialState';
      instances: PublicForgejoInstance[];
      locale: 'en' | 'zh';
      debug: boolean;
      /**
       * Whether `forgejoToolkit.aiPreReview` is on, so the dashboard can hide the
       * affordances whose only outcome with it off would be a refusal.
       *
       * It is the same shape as `debug`: the host is the one place the setting is
       * read, and the webview renders a switch it was told about rather than
       * reading configuration it cannot see. The feature's own refusal stays
       * wherever it is — a hidden button is an affordance, not the gate.
       *
       * Optional because one message type is shared by every webview document:
       * only the dashboard offers an AI pre-review entry, and the onboarding
       * wizard and the review-comment editor have no use for a flag they never
       * send. A reader must treat a missing value as **off** — reading undefined
       * as "on" would offer a button whose only outcome is the run's refusal.
       */
      aiPreReview?: boolean;
      /**
       * Whether `forgejoToolkit.prDescription` is on, so the create-pull-request
       * form can hide its "Generate description" control whose only outcome with
       * the feature off would be a refusal.
       *
       * The same contract as `aiPreReview` above: the host reads the setting and
       * the webview renders what it was told, a missing value reads as **off**,
       * and the run's own refusal remains the gate — a hidden control is an
       * affordance, not the guarantee.
       */
      prDescription?: boolean;
      /**
       * The oldest Forgejo release this build supports, as the host spells it in
       * its own low-version notices (`MIN_SUPPORTED_VERSION_TEXT`), so a view
       * that has to show a version *example* can show the real floor instead of
       * a literal that drifts from it.
       *
       * The Settings instance form is the one consumer: its "Server version"
       * description names the floor as the accepted shape. It is optional for
       * the same reason `aiPreReview` is — one message type serves every webview
       * document, and the panels that send it have no version field to describe
       * — so a reader must treat a missing value as "show no example" rather
       * than as a number of its own.
       */
      minSupportedServerVersion?: string;
      worktrees: unknown[];
      worktreeOpenMode: 'ask' | 'currentWindow' | 'newWindow';
      worktreeCacheDirectory: string;
      worktreeCacheDirectoryDefault: string;
    }
  | { command: 'openSettings' }
  | { command: 'openDashboard' }
  | { command: 'openNotifications' }
  // Fallback reply for any request/response message whose handler finished
  // (or threw) without sending its specific reply.
  | { command: 'requestError'; _requestId: string; error: string }
  | { command: 'openCreatePullRequest'; instanceId: string; owner: string; repo: string; head: string }
  | { command: 'openNewIssue'; instanceId: string; owner: string; repo: string; title?: string; body?: string }
  | { command: 'openPullRequestDetail'; instanceId: string; owner: string; repo: string; index: number }
  | {
      command: 'startWorkResult';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** The created worktree, so the settings list can show it without a reload. */
      worktree?: unknown;
      cancelled?: boolean;
      error?: string;
    }
  | { command: 'setLocale'; locale: 'en' | 'zh' }
  | { command: 'setDebug'; debug: boolean }
  // Pushed when `forgejoToolkit.aiPreReview` changes in VS Code's Settings UI,
  // which is the only place it can be changed: the dashboard offers or hides the
  // pull-request-level run button on it, and a boolean read once at mount would
  // leave that button describing the switch's previous state. Same shape as
  // `setDebug`, and like it the value only drives an affordance — the run reads
  // the setting itself.
  | { command: 'setAiPreReview'; aiPreReview: boolean }
  /**
   * Pushed when `forgejoToolkit.prDescription` changes in VS Code's Settings UI.
   *
   * The create-pull-request form offers or hides its "Generate description"
   * control on it, and that form can sit open for as long as the user is writing a
   * title, so a boolean read once at mount would leave the control describing the
   * switch's previous state. Same contract as `setAiPreReview`: the value only
   * drives an affordance, and the run reads the setting itself.
   */
  | { command: 'setPrDescription'; prDescription: boolean }
  | {
      command: 'repositories';
      instanceId: string;
      repositories?: unknown[];
      /** The server's `X-Total-Count` for the list, when the instance reported one. */
      totalCount?: number;
      /**
       * The `_requestId` of the `getRepositories` request this answers, echoed
       * verbatim. Optional because a reply that cannot carry it is still valid:
       * a host build that predates the echo sends none, and the webview falls
       * back to its per-instance queue for those (see `useAppState`'s
       * consumeInstanceListReply). A reply that carries an id the webview has no
       * outstanding request for is dropped.
       */
      _requestId?: string;
      error?: string;
    }
  | {
      command: 'myIssues';
      instanceId: string;
      state: string;
      issues?: unknown[];
      /** The `_requestId` echoed from the request; see `repositories`. */
      _requestId?: string;
      error?: string;
    }
  | {
      command: 'myPullRequests';
      instanceId: string;
      state: string;
      pullRequests?: unknown[];
      /** The `_requestId` echoed from the request; see `repositories`. */
      _requestId?: string;
      error?: string;
    }
  | { command: 'repoDetail'; instanceId: string; owner: string; repo: string; detail?: unknown; error?: string }
  | {
      command: 'repoBranchCommits';
      instanceId: string;
      owner: string;
      repo: string;
      branch: string;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'issueDetail';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      detail?: unknown;
      error?: string;
    }
  | {
      command: 'pullRequestDetail';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      detail?: unknown;
      /**
       * Set, and only ever `true`, when the host's attachments probe failed:
       * `detail.assets` is then empty for a reason that is not "this pull request
       * has none". A consumer must carry the flag beside the stored detail
       * instead of writing `false` over it — that would turn a known failure into
       * a silent "no attachments". Absent means the probe succeeded, so an empty
       * `assets` list really is "no attachments".
       */
      attachmentsUnavailable?: boolean;
      error?: string;
    }
  | {
      command: 'issueCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'issueUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      /** Echoed from editIssue: this was a close/reopen toggle, not a form edit. */
      stateToggle?: boolean;
      /** Echoed from editIssue: this was an inline due-date save, not a form edit. */
      dueDateUpdate?: boolean;
    }
  | {
      command: 'issueDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'issueCommentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      comment?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'issueCommentEdited';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      comment?: unknown;
      error?: string;
    }
  | {
      command: 'issueCommentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'issueCommentAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      attachmentId: number;
      /** Set when the user declined the host-side confirmation: nothing was deleted. */
      cancelled?: boolean;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'issueCommentAttachmentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      commentId: number;
      id?: number;
      uuid?: string;
      name?: string;
      size?: number;
      browser_download_url?: string;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'pullRequestReviewSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'pullRequestMerged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** The user declined the host-side confirmation; nothing was merged. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'revertMergeCommitResult';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** True only when the revert commit was created *and* pushed. */
      success?: boolean;
      /** The user declined the host-side confirmation; nothing was reverted. */
      cancelled?: boolean;
      /**
       * Why the revert did not happen, plus the state the local repository was
       * left in. The host never reports a failure through `success` without a
       * reason here, so a failed revert cannot look like a silent no-op.
       */
      error?: string;
    }
  | {
      command: 'issueAttachmentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      id?: number;
      uuid?: string;
      name?: string;
      size?: number;
      browser_download_url?: string;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'pullRequestCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'pullRequestUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      /** Echoed from editPullRequest: this was a close/reopen toggle, not a form edit. */
      stateToggle?: boolean;
      /** Echoed from editPullRequest: this was an inline due-date save, not a form edit. */
      dueDateUpdate?: boolean;
    }
  /**
   * One generated draft, or the sentence saying why there is none.
   *
   * `description` is present only on success, and `error` only on failure: the
   * form writes its body field from the first and shows the second as a message,
   * and neither ever overwrites what the user typed (the host writes no file, no
   * setting and no pull request on either arm).
   */
  | {
      command: 'prDescriptionGenerated';
      description?: string;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'pullRequestFiles';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      baseSha?: string;
      headSha?: string;
      files?: unknown[];
      error?: string;
    }
  | {
      command: 'pullRequestCommentsAndTimeline';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      comments?: unknown[];
      error?: string;
    }
  | {
      command: 'pullRequestCommits';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'repoIssues';
      instanceId: string;
      owner: string;
      repo: string;
      state: string;
      query?: string;
      issues?: unknown[];
      /** The server's `X-Total-Count` for the list, when the instance reported one. */
      totalCount?: number;
      error?: string;
    }
  | {
      command: 'repoPullRequests';
      instanceId: string;
      owner: string;
      repo: string;
      state: string;
      query?: string;
      pullRequests?: unknown[];
      /** The server's `X-Total-Count` for the list, when the instance reported one. */
      totalCount?: number;
      error?: string;
    }
  | {
      command: 'actionRuns';
      instanceId: string;
      owner: string;
      repo: string;
      page: number;
      actionRuns?: unknown[];
      totalCount?: number;
      error?: string;
    }
  | {
      command: 'actionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      run?: unknown;
      error?: string;
    }
  | {
      command: 'actionRunJobs';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      jobs?: unknown[];
      error?: string;
    }
  | {
      command: 'actionRunArtifacts';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      artifacts?: unknown[];
      error?: string;
    }
  | {
      command: 'actionJobLog';
      instanceId: string;
      owner: string;
      repo: string;
      jobId: number;
      log?: string;
      error?: string;
    }
  | {
      command: 'actionRunDispatched';
      instanceId: string;
      owner: string;
      repo: string;
      workflowfilename: string;
      /**
       * Whether the host accepted the dispatch. The host only ever sends `true`
       * — a declined confirmation answers with `cancelled: true` instead, and a
       * failure with `error` — so a consumer need not branch on it today; a
       * consumer that does branch must treat an absent or `false` value as "not
       * dispatched" rather than as success.
       */
      accepted?: boolean;
      run?: unknown;
      /** The user declined the host-side confirmation; nothing was dispatched. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'workflowDispatchInputs';
      instanceId: string;
      owner: string;
      repo: string;
      /** The workflow filename the request named, echoed for routing. */
      workflow: string;
      /** The ref the request named, echoed for routing. */
      ref: string;
      /**
       * The inputs the workflow file declares, in file order. Absent (or empty)
       * means the dispatch form has nothing to render per input and keeps its
       * raw key/value editor — see `reason` for which fallback applies.
       */
      inputs?: unknown[];
      /** The repository path the inputs were read from, when a file was found. */
      path?: string;
      /**
       * Why the reply carries no usable inputs: the workflow declares none, or
       * its file could not be read/parsed. Both leave the raw editor available,
       * so neither is an error state; a fetch failure carries `error` with it.
       */
      reason?: 'no-inputs' | 'unreadable';
      error?: string;
    }
  | {
      command: 'actionRunCancelled';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      success?: boolean;
      /** The user declined the host-side confirmation; the run was not cancelled. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'actionArtifactDownloaded';
      instanceId: string;
      owner: string;
      repo: string;
      artifactId: number;
      /** Where the artifact was saved. Sent only on success, never beside `cancelled` or `error`. */
      path?: string;
      /**
       * The user dismissed the save dialog: nothing was downloaded. A cancel
       * carries no `error`, so a consumer that only branches on `error` reads the
       * reply as success — `cancelled` must be handled *before* the reply is
       * treated as success, and it must not clear an error already shown for this
       * artifact (a declined dialog does not fix the earlier failure).
       */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'actionRunDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      success?: boolean;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'repoLabels';
      instanceId: string;
      owner: string;
      repo: string;
      labels?: unknown[];
      error?: string;
    }
  | {
      command: 'repoAssignees';
      instanceId: string;
      owner: string;
      repo: string;
      assignees?: string[];
      error?: string;
    }
  | {
      command: 'repoMilestones';
      instanceId: string;
      owner: string;
      repo: string;
      milestones?: unknown[];
      error?: string;
    }
  | { command: 'renderedMarkdown'; _requestId: string; html?: string; error?: string }
  | {
      command: 'repoContents';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      path: string;
      entries?: unknown[];
      error?: string;
    }
  | {
      command: 'repoFilesSearchResult';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      query: string;
      files?: unknown[];
      /**
       * True when the answer is incomplete, whichever cause cut it short, so a
       * short `files` list must not be read as the whole repository. This flag
       * deliberately says nothing about *why* the search stopped: read
       * `truncatedBy` for that.
       */
      truncated?: boolean;
      /**
       * Why `truncated` is true: `'tree'` means the git tree could not be read
       * completely (matches may be missing and no query can recover them), while
       * `'matches'` means the whole tree was read and the match list hit its cap
       * (a narrower query returns the rest). Absent when `truncated` is false or
       * when the host built the payload before this field existed, in which case
       * a consumer must not promise that narrowing recovers anything: an
       * unreadable tree is the safer cause to name.
       */
      truncatedBy?: 'matches' | 'tree';
      error?: string;
    }
  | {
      command: 'fileHistory';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      ref: string;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'repoRefs';
      instanceId: string;
      owner: string;
      repo: string;
      branches?: unknown[];
      tags?: unknown[];
      releases?: unknown[];
      error?: string;
    }
  | {
      command: 'repoBranchCreated';
      instanceId: string;
      owner: string;
      repo: string;
      branch?: string;
      error?: string;
    }
  | {
      command: 'repoBranchDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      branch?: string;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'repoTagCreated';
      instanceId: string;
      owner: string;
      repo: string;
      tag?: string;
      error?: string;
    }
  | {
      command: 'repoTagDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      tag?: string;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'repoReleaseCreated';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      item?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'repoReleaseDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'repoReleaseEdited';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      error?: string;
    }
  | {
      command: 'releaseAttachmentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachment?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'releaseAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachmentId: number;
      /** Set when the user declined the host-side confirmation: nothing was deleted. */
      cancelled?: boolean;
      error?: string;
      _requestId: string;
    }
  | { command: 'showInputBoxResult'; id: string; value?: string; cancelled: boolean }
  | { command: 'showConfirmResult'; id: string; confirmed: boolean }
  | { command: 'worktreesList'; worktrees: unknown[] }
  | {
      command: 'worktreeOpened';
      worktree: unknown;
      /**
       * Whether the worktree's path already existed before the command (the host
       * reports this on every `worktreeOpened` reply). No consumer reads it today;
       * a consumer that wants to tell the user "reused the existing checkout"
       * must branch on this field, not on the `worktree` payload's own fields.
       */
      existed?: boolean;
    }
  | { command: 'worktreeCancelled'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'worktreeRemoved'; id: string }
  | {
      command: 'worktreeError';
      error: string;
      /** Which operation failed, so the webview can route the error to the right view. */
      operation?: 'open' | 'remove';
      instanceId?: string;
      owner?: string;
      repo?: string;
      index?: number;
    }
  | {
      command: 'issueAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      attachmentId: number;
      /** Set when the user declined the host-side confirmation: nothing was deleted. */
      cancelled?: boolean;
      error?: string;
      _requestId: string;
    }
  | { command: 'worktreeOpenMode'; mode: 'ask' | 'currentWindow' | 'newWindow' }
  | { command: 'worktreeCacheDirectory'; directory: string; defaultDirectory: string }
  // The AI pre-review chat models this editor offers, for the Settings page's
  // chooser. `configured` is `forgejoToolkit.aiPreReviewModel` exactly as it is
  // stored (`''` means "ask me"), and `reason` is the localized explanation the
  // page shows instead of an empty dropdown when there is nothing to offer —
  // no language model API, a listing that failed, or no model at all.
  | {
      command: 'aiPreReviewChatModels';
      models: AiPreReviewChatModelOption[];
      configured: string;
      reason?: string;
      _requestId: string;
    }
  // The choice was stored (or not). `error` is localized by the host, and
  // `value` is the value the write was attempted with, so the page can say what
  // it did without re-reading the configuration.
  | { command: 'aiPreReviewChatModelSaved'; value: string; error?: string; _requestId: string }
  // The settings page's AI endpoint (provider) surface. The snapshot is the
  // whole screen's state in one message, so it is also pushed — without a
  // `_requestId` — after a write that changes what the page would render (a
  // removal, whose host-side confirmation means the webview cannot track it as a
  // request/response pair).
  | { command: 'aiProviderSettings'; snapshot: AiProviderSettingsSnapshot; _requestId?: string }
  | { command: 'aiProviderSaved'; id: string; error?: string; _requestId: string }
  | {
      /** `headerName` absent answers the API key; present, that header's value. */
      command: 'aiProviderSecretSaved';
      id: string;
      headerName?: string;
      set: boolean;
      error?: string;
      _requestId: string;
    }
  | {
      /**
       * `cancelled` is the user declining the host's own confirmation: nothing
       * was removed, and that is not an error.
       */
      command: 'aiProviderRemoved';
      id: string;
      cancelled?: boolean;
      error?: string;
      _requestId: string;
    }
  | { command: 'aiProviderTestReport'; report: AiProviderTestReport; _requestId: string }
  // The settings page's own surface: the nine settings its sections present with
  // a control (`docs/design/settings-page.md` §3.2). Reading one sends nothing
  // anywhere and writes nothing; a write answers with the host's reading of the
  // state it produced, plus its own sentence when the write failed.
  | { command: 'settingsSurface'; snapshot: SettingsSurfaceSnapshot; error?: string; _requestId: string }
  | {
      command: 'aiModelPolicySaved';
      enabled: boolean;
      transport: 'auto' | 'vscode-lm' | 'openai-compatible';
      localOnly: boolean;
      requestTimeoutMs: number;
      error?: string;
      _requestId: string;
    }
  | {
      /** `providerId` empty means "no binding": the feature falls back to the transport choice. */
      command: 'aiModelBindingSaved';
      feature: string;
      providerId: string;
      modelId: string;
      error?: string;
      _requestId: string;
    }
  | {
      /**
       * The default destination was stored (or cleared, when both fields are
       * empty) — the answer to the page's own default row, which is a different
       * setting pair from the per-feature overrides above.
       */
      command: 'aiDefaultModelSaved';
      providerId: string;
      modelId: string;
      error?: string;
      _requestId: string;
    }
  | { command: 'testConnectionResult'; success: boolean; username?: string; error?: string }
  | { command: 'saveInstanceResult'; success: boolean; error?: string }
  | { command: 'linkedRepository'; linked?: LinkedRepository; all?: LinkedRepository[] }
  | {
      command: 'globalSearchResult';
      instanceId: string;
      scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
      query: string;
      state: string;
      repositories?: unknown[];
      issues?: unknown[];
      pullRequests?: unknown[];
      error?: string;
    }
  | {
      command: 'notifications';
      instanceId: string;
      notifications?: unknown[];
      /** The server's `X-Total-Count` for the filtered list, when the instance reported one. */
      totalCount?: number;
      /**
       * Echoes the `before` cursor of the answered request, which is how the
       * webview attributes a reply to the request it answers (the host may
       * answer two in flight out of order after an instance edit). The webview
       * sends a cursor on every request: "load more" passes the real one, a
       * first page passes a far-future placeholder that selects the same
       * unfiltered page, so this field is present on any page reply and absent
       * only from an error reply.
       */
      before?: string;
      error?: string;
    }
  | {
      /** Poller pushes land in a separate slot from the user's filtered view. */
      command: 'polledNotifications';
      instanceId: string;
      notifications?: unknown[];
      /**
       * The ids this poll examined, reported by the poller itself — not derived
       * from `notifications` by the sender, because the rows a poll examined are
       * not always the rows it returned:
       *
       * - a poll of the unread set whose page came back short has examined every
       *   row it saw unread before, so a row that is now read is covered even
       *   though it is absent from `notifications`;
       * - "mark all as read" (from the host toast, with no webview command
       *   behind it) covers the ids that were marked, and the refresh poll that
       *   follows may return an empty list.
       *
       * A view may only treat a row as read when the poller examined it (a row
       * beyond a full, possibly truncated page was never looked at), so rows
       * outside this list are never reconciled away. Absent on a legacy host,
       * which leaves the view to speak only for the rows it received.
       */
      coveredIds?: number[];
      /** Set when the poll itself failed (e.g. invalid token, instance down). */
      error?: string;
    }
  | {
      command: 'notificationMarkedRead';
      instanceId: string;
      id: number;
      error?: string;
    }
  | {
      command: 'allNotificationsMarkedRead';
      instanceId: string;
      error?: string;
    }
  | {
      command: 'instancesExported';
      success: boolean;
      path?: string;
      error?: string;
      /** The user dismissed the export dialog; not a failure. */
      cancelled?: boolean;
      /**
       * Whether the file carries AI endpoint credentials — i.e. whether the user
       * chose the encrypted export. Absent on a reply that failed, was cancelled,
       * or came from a host build that predates the field, and the settings page
       * then says nothing rather than claiming a file was written without secrets
       * when none was written at all.
       */
      aiSecretsIncluded?: boolean;
    }
  | {
      command: 'instancesImported';
      success: boolean;
      count?: number;
      error?: string;
      /** True when the user dismissed the file picker or the password prompt; the webview drops the result instead of reporting a failure. */
      cancelled?: boolean;
    }
  | {
      command: 'importInstancesPreview';
      /**
       * Instances from the export file without their tokens: the field is
       * excluded at the type level (`ImportPreviewInstance`), so a payload
       * that still carries a token does not compile at the sender. The host
       * keeps the full entries stashed and rehydrates them by id on
       * `importInstances`.
       */
      instances: ImportPreviewInstance[];
      existingIds: string[];
      /**
       * Parallel to `instances`: true when the token collides with a
       * different existing instance or is duplicated within the file.
       * Computed host-side so token values are never sent to the webview.
       */
      tokenConflicts?: boolean[];
      settings?: ExportSettings;
      /**
       * The AI half of the file (`docs/design/ai-model-transport.md` §10.1). Absent
       * on a reply from a host build that predates AI import, and on a file with no
       * `ai` section (every `version: 1`/`2` payload): the view then shows no AI
       * block, which is exactly "this file carried no AI configuration".
       */
      ai?: {
        providers: AiImportPreviewProvider[];
        bindings: Array<{ feature: string; providerId: string; modelId: string }>;
        transport: 'auto' | 'vscode-lm' | 'openai-compatible';
        localOnly: boolean;
        /**
         * Whether the file carried credentials at all — i.e. whether it was
         * encrypted (§10.2). Stated plainly in the preview, because a plaintext
         * export contains no API key and no header value, and the endpoints it
         * carries will therefore have no credential until the user adds one.
         */
        secretsIncluded: boolean;
      };
      error?: string;
      /**
       * How many entries of the import file the host had to skip. Present only
       * when greater than zero: the dropped entries never appear in `instances`,
       * so without the count the preview looks complete. An absent field means
       * nothing was dropped — including on a reply from a host build that
       * predates the count, which a consumer treats as "nothing to warn about"
       * rather than as a failure.
       */
      dropped?: number;
      /** True when the user dismissed the file picker; the webview frees its pending slot without navigating. */
      cancelled?: boolean;
    }
  | {
      command: 'issueSubscriptionChecked';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      subscribed?: boolean;
      error?: string;
    }
  | {
      command: 'issueSubscriptionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      subscribed?: boolean;
      error?: string;
    }
  | {
      command: 'issueStopwatchChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      action: 'start' | 'stop' | 'delete';
      /** Set when the user declined the host-side confirmation: nothing changed. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'userStopwatches';
      instanceId: string;
      stopwatches?: unknown[];
      error?: string;
    }
  | {
      command: 'issueTrackedTimes';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      times?: unknown[];
      error?: string;
    }
  | {
      command: 'issueTimeAdded';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      time?: unknown;
      error?: string;
    }
  | {
      command: 'issueTimeReset';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** The user declined the host-side confirmation; nothing was reset. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'issueTimeDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      id: number;
      /** The user declined the host-side confirmation; nothing was deleted. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'issueDependencies';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencies?: unknown[];
      error?: string;
    }
  | {
      command: 'issueDependencyChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /**
       * The other issue's number, echoed from the request so a consumer can route
       * the reply. No consumer reads it today; one that starts reading it must
       * still reload, because the reply carries no dependency payload.
       */
      dependencyIndex: number;
      /** Echoed from the request ('add' for create, 'remove' for remove). Not read by any consumer today. */
      action: 'add' | 'remove';
      /** The user declined the host-side confirmation; nothing was changed. */
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'issueReactions';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reactions?: unknown[];
      error?: string;
    }
  | {
      command: 'issueReactionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      content: string;
      action: 'add' | 'remove';
      error?: string;
    }
  | {
      command: 'commentReactions';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      reactions?: unknown[];
      error?: string;
    }
  | {
      command: 'commentReactionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      content: string;
      action: 'add' | 'remove';
      error?: string;
    }
  | {
      command: 'mentionSearchResult';
      _requestId: string;
      users?: unknown[];
      issues?: unknown[];
      error?: string;
    }
  | {
      command: 'userPreviewResult';
      _requestId: string;
      user?: unknown;
      error?: string;
    }
  | {
      command: 'issuePreviewResult';
      _requestId: string;
      issue?: unknown;
      error?: string;
    }
  | {
      command: 'openPullReviewCommentEditor';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      path: string;
      position: number;
      isBase: boolean;
      lineNumber: number;
      /** Additional lines after `lineNumber` for multi-line comments (0/undefined = single line). */
      extraLinesCount?: number;
      mode: 'single' | 'review';
      pendingReviewId?: number;
    }
  | {
      // The panel is a singleton: before reusing it for a different line/PR
      // the host asks whether the current editor holds an unsubmitted draft.
      command: 'queryPullReviewCommentDraft';
    }
  | {
      command: 'pullReviewCommentSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId?: number;
      error?: string;
    }
  | {
      command: 'pullReviewSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      error?: string;
    }
  | {
      command: 'pullReviewDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** True when the user declined the confirmation dialog; the review still exists. */
      cancelled?: boolean;
      error?: string;
    }
  // The AI pre-review panel. The payload is also injected into the document
  // config (like the review-comment editor's context), so the first paint does
  // not need a round trip; this message is what a rewritten payload would use.
  | { command: 'aiPreReviewPanelPayload'; payload: AiPreReviewPanelPayload }
  // What the run's write produced, posted after the decision so the panel can
  // show the outcome and offer the way to the pending review.
  | { command: 'aiPreReviewPanelResult'; created: number; failure?: string }
  // The host refused a Create outright and created nothing, so the question is
  // still open: the panel shows this reason beside its buttons and lets the user
  // fix the named card and press Create again. A Create is refused as a whole —
  // never partly honoured — when an entry fails validation (an index that was not
  // offered, a body that is not a string, empty after trimming, or over the
  // per-comment cap), which a legitimate panel can only reach by being modified.
  | { command: 'aiPreReviewPanelRejected'; reason: string };

export type WebviewToHostMessage =
  | { command: 'getInitialState' }
  | { command: 'getLinkedRepository' }
  | { command: 'testConnection'; url: string; token: string; instanceId?: string }
  | { command: 'saveInstance'; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean }
  | { command: 'editInstance'; id: string; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean }
  | { command: 'removeInstance'; id: string }
  | {
      command: 'deleteIssueAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      attachmentId: number;
      _requestId: string;
    }
  | { command: 'setLocale'; locale: string }
  | { command: 'setDebug'; debug: boolean }
  // The Settings page's AI pre-review model chooser: read the offered models,
  // and store the one the user picks. Neither sends anything to a provider, and
  // both work with `forgejoToolkit.aiPreReview` off — choosing is configuration,
  // not use.
  | { command: 'getAiPreReviewChatModels'; _requestId: string }
  | { command: 'setAiPreReviewChatModel'; value: string; _requestId: string }
  // The settings page's AI endpoint surface. Reading the snapshot sends nothing
  // anywhere (`selectedModelFor` only lists models and reads secrets), the two
  // secret writes go straight to `SecretStorage` — never into a setting — and
  // `testAiProvider` is the one command here that sends a request to the
  // configured endpoint, which is why it is only ever posted from an explicit
  // click (§7.2).
  | { command: 'getAiProviderSettings'; _requestId: string }
  | {
      command: 'saveAiProvider';
      provider: {
        id: string;
        name: string;
        baseUrl: string;
        models: AiProviderModelDraft[];
        auth: AiProviderAuthValue;
        /** Header **names** only: a value is written through `setAiProviderSecret`. */
        headers: string[];
        localOnly: boolean;
      };
      _requestId: string;
    }
  | { command: 'removeAiProvider'; id: string; _requestId: string }
  | {
      /** `headerName` absent writes the API key; present, that header's value. `''` clears it. */
      command: 'setAiProviderSecret';
      id: string;
      headerName?: string;
      value: string;
      _requestId: string;
    }
  | { command: 'testAiProvider'; id: string; _requestId: string }
  // The draft probe (§4 of the settings-page record): the same report shape the
  // explicit test answers with, for an endpoint that has not been saved. It is
  // the first path in this extension that a request leaves the machine on without
  // a click — a typed, complete address and credential arm it after 800 ms of
  // idle — so it stays deliberately narrow: `GET /models` only, one shot per
  // input combination, refused locally before any byte when the local-only rule
  // forbids the address, and it never carries a saved endpoint's identity.
  | { command: 'testAiProviderDraft'; draft: AiProviderDraftProbe; _requestId: string }
  | { command: 'getSettingsSurface'; _requestId: string }
  | {
      command: 'setSettingsSurfaceValue';
      key: SettingsSurfaceWritableKey;
      value: boolean | string;
      _requestId: string;
    }
  // The settings page's way into VS Code's own settings editor, filtered to this
  // extension (`docs/design/settings-page.md` §2.1). A webview cannot run a
  // command, so the host runs the one the per-section pointers and the page
  // header both name. No reply: the effect is a window the user is looking at.
  | { command: 'openNativeSettings' }
  | {
      command: 'setAiModelPolicy';
      enabled: boolean;
      transport: 'auto' | 'vscode-lm' | 'openai-compatible';
      localOnly: boolean;
      requestTimeoutMs: number;
      _requestId: string;
    }
  | {
      command: 'setAiModelBinding';
      feature: string;
      /** Empty removes the binding: the feature goes back to the transport choice. */
      providerId: string;
      modelId: string;
      _requestId: string;
    }
  | {
      /**
       * Stores (or clears) the **default** destination the per-feature overrides
       * sit on top of (`docs/design/ai-model-transport.md` §8.4). Both fields
       * empty clears it; one empty and one not is refused by name rather than
       * resolved to a guess.
       */
      command: 'setAiDefaultModel';
      providerId: string;
      modelId: string;
      _requestId: string;
    }
  // The three dashboard lists are the only loaders whose reply cannot be told
  // apart by its own fields: an instance edit keeps the id, so the replaced
  // server's reply and the reload's reply carry the same `instanceId` (and the
  // same echoed `state`). Without a request id the webview had to judge a reply
  // by the oldest record it still had queued, which cannot separate the two when
  // they arrive out of send order. The opaque `_requestId` travels with the
  // request and comes back on the reply so attribution needs no ordering
  // assumption (see `useAppState`'s consumeInstanceListReply).
  | { command: 'getRepositories'; instanceId: string; _requestId: string }
  | { command: 'getMyIssues'; instanceId: string; state?: string; _requestId: string }
  | { command: 'getMyPullRequests'; instanceId: string; state?: string; _requestId: string }
  | { command: 'getRepoDetail'; instanceId: string; owner: string; repo: string }
  | {
      command: 'getRepoBranchCommits';
      instanceId: string;
      owner: string;
      repo: string;
      branch: string;
    }
  | { command: 'getIssueDetail'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'getPullRequestDetail'; instanceId: string; owner: string; repo: string; index: number }
  | {
      command: 'createIssue';
      instanceId: string;
      owner: string;
      repo: string;
      data: {
        title: string;
        body: string;
        ref?: string;
        labels?: number[];
        assignees?: string[];
        milestone?: number;
        due_date?: string;
      };
      _requestId: string;
    }
  | {
      command: 'editIssue';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: {
        title?: string;
        body?: string;
        state?: 'open' | 'closed';
        labels?: number[];
        assignees?: string[];
        milestone?: number;
        due_date?: string;
        unset_due_date?: boolean;
        /** Marks a close/reopen toggle: stripped before the API call, echoed as stateToggle. */
        state_toggle?: boolean;
        /** Marks an inline due-date save: stripped before the API call, echoed as dueDateUpdate. */
        due_date_update?: boolean;
      };
    }
  | {
      command: 'deleteIssue';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'createIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      body: string;
      _requestId: string;
    }
  | {
      command: 'editIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      body: string;
    }
  | {
      command: 'deleteIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
    }
  | {
      command: 'deleteIssueCommentAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      attachmentId: number;
      _requestId: string;
    }
  | {
      command: 'createIssueCommentAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      commentId: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'mergePullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      strategy: 'merge' | 'rebase' | 'squash';
    }
  | {
      command: 'revertMergeCommit';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'createIssueAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'createPullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      data: {
        title: string;
        body: string;
        base?: string;
        head?: string;
        assignees?: string[];
        labels?: number[];
        milestone?: number;
        due_date?: string;
      };
      _requestId: string;
    }
  // The create-pull-request form's "generate a description" action.
  //
  // The coordinates are the whole payload on purpose, exactly as they are for
  // `aiPreReviewPullRequest`: the webview says **which comparison** the user is
  // about to submit and nothing else. The model, the prompt scope, the prompt and
  // the consent question are all the host's, so a modified webview cannot
  // influence what leaves the machine — and this message can never create or
  // submit anything, because the host half only ever answers with text.
  | {
      command: 'generatePrDescription';
      instanceId: string;
      owner: string;
      repo: string;
      base: string;
      head: string;
      _requestId: string;
    }
  | {
      command: 'editPullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: {
        title?: string;
        body?: string;
        state?: 'open' | 'closed';
        base?: string;
        assignees?: string[];
        labels?: number[];
        milestone?: number;
        due_date?: string;
        unset_due_date?: boolean;
        /** Marks a close/reopen toggle: stripped before the API call, echoed as stateToggle. */
        state_toggle?: boolean;
        /** Marks an inline due-date save: stripped before the API call, echoed as dueDateUpdate. */
        due_date_update?: boolean;
      };
    }
  | {
      command: 'getPullRequestFiles';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      baseSha?: string;
      headSha?: string;
    }
  | {
      command: 'getPullRequestCommentsAndTimeline';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'getPullRequestCommits';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'openPullRequestDiff';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      filename: string;
      status: string;
      /** Old path of a renamed file; the base side must be fetched under it. */
      previousFilename?: string;
      baseSha: string;
      headSha: string;
    }
  | {
      command: 'openSelectedPullRequestDiffs';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      files: { filename: string; status: string; previous_filename?: string }[];
      baseSha: string;
      headSha: string;
    }
  | { command: 'getRepoIssues'; instanceId: string; owner: string; repo: string; state?: string; query?: string }
  | { command: 'getRepoPullRequests'; instanceId: string; owner: string; repo: string; state?: string; query?: string }
  | { command: 'getActionRuns'; instanceId: string; owner: string; repo: string; page?: number; limit?: number }
  | { command: 'getActionRun'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionRunJobs'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionRunArtifacts'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionJobLog'; instanceId: string; owner: string; repo: string; jobId: number }
  | {
      command: 'getWorkflowDispatchInputs';
      instanceId: string;
      owner: string;
      repo: string;
      /** The workflow filename as the dispatch names it (`workflow_id`). */
      workflow: string;
      /** The ref the form has selected: the file is read at that ref. */
      ref: string;
    }
  | {
      command: 'dispatchWorkflow';
      instanceId: string;
      owner: string;
      repo: string;
      workflowfilename: string;
      ref: string;
      inputs?: Record<string, string>;
    }
  | {
      command: 'cancelActionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
    }
  | {
      command: 'deleteActionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
    }
  | {
      command: 'downloadActionArtifact';
      instanceId: string;
      owner: string;
      repo: string;
      artifactId: number;
      name: string;
    }
  | { command: 'getRepoLabels'; instanceId: string; owner: string; repo: string }
  | { command: 'getRepoAssignees'; instanceId: string; owner: string; repo: string }
  | { command: 'getRepoMilestones'; instanceId: string; owner: string; repo: string }
  | { command: 'renderMarkdown'; instanceId: string; text: string; context?: string; _requestId: string }
  | { command: 'getRepoContents'; instanceId: string; owner: string; repo: string; path: string; ref: string }
  | { command: 'openRepoFile'; instanceId: string; owner: string; repo: string; path: string; ref: string }
  | {
      command: 'searchRepoFiles';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      query: string;
    }
  | {
      command: 'getFileHistory';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      ref: string;
    }
  | {
      command: 'openRepoFileDiff';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      baseRef: string;
      headRef: string;
    }
  | { command: 'getRepoRefs'; instanceId: string; owner: string; repo: string }
  | {
      command: 'createRepoBranch';
      instanceId: string;
      owner: string;
      repo: string;
      newBranchName: string;
      oldRefName?: string;
    }
  | { command: 'deleteRepoBranch'; instanceId: string; owner: string; repo: string; branch: string }
  | {
      command: 'createRepoTag';
      instanceId: string;
      owner: string;
      repo: string;
      tagName: string;
      target?: string;
      message?: string;
    }
  | { command: 'deleteRepoTag'; instanceId: string; owner: string; repo: string; tag: string }
  | {
      command: 'createRepoRelease';
      instanceId: string;
      owner: string;
      repo: string;
      tagName: string;
      name?: string;
      body?: string;
      targetCommitish?: string;
      prerelease?: boolean;
      draft?: boolean;
      hideArchiveLinks?: boolean;
      _requestId: string;
    }
  | { command: 'deleteRepoRelease'; instanceId: string; owner: string; repo: string; id: number }
  | {
      command: 'createReleaseAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'deleteReleaseAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachmentId: number;
      _requestId: string;
    }
  | {
      command: 'editRepoRelease';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      data: {
        tag_name?: string;
        name?: string;
        body?: string;
        target_commitish?: string;
        prerelease?: boolean;
        draft?: boolean;
        hide_archive_links?: boolean;
      };
    }
  | { command: 'showInputBox'; id: string; prompt: string; value?: string; placeHolder?: string }
  | { command: 'showConfirm'; id: string; message: string; confirmLabel: string }
  | { command: 'copyToClipboard'; text: string }
  | { command: 'openExternal'; url: string }
  // Opens a recorded worktree path in the OS file manager. The host validates
  // the path against the known worktree list instead of trusting a URI.
  | { command: 'openWorktreePath'; path: string }
  // The instance id keys the virtual README document: without it two instances
  // share one document, so one instance's README could be shown for the other.
  | { command: 'previewReadme'; instanceId?: string; owner: string; repo: string; content: string }
  | { command: 'openPrWorktree'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'startWorkOnIssue'; instanceId: string; owner: string; repo: string; index: number; title?: string }
  | { command: 'removeWorktree'; id: string }
  | { command: 'setWorktreeOpenMode'; mode: 'ask' | 'currentWindow' | 'newWindow' }
  | { command: 'setWorktreeCacheDirectory'; directory: string }
  | { command: 'browseWorktreeCacheDirectory' }
  | { command: 'openOnboardingPanel' }
  | { command: 'closeOnboarding' }
  | {
      command: 'globalSearch';
      instanceId: string;
      scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
      query: string;
      state: string;
      limit?: number;
    }
  | {
      command: 'getNotifications';
      instanceId: string;
      statusTypes?: string[];
      subjectType?: string[];
      limit?: number;
      /**
       * Only notifications updated before this RFC 3339 instant, i.e. the
       * cursor for the next page. A cursor instead of a page number because
       * marking notifications read removes them from the filtered server list
       * and would shift every later offset.
       */
      before?: string;
    }
  | {
      command: 'markNotificationRead';
      instanceId: string;
      id: number;
    }
  | {
      command: 'markAllNotificationsRead';
      instanceId: string;
    }
  | { command: 'exportInstances'; ids?: string[] }
  | { command: 'copyInstancesToClipboard'; ids?: string[] }
  | { command: 'previewImportInstances' }
  | {
      command: 'importInstances';
      /**
       * Ids of the instances selected in the preview. The host rehydrates
       * the full entries (including tokens) from its stashed preview data —
       * any instance data sent by the webview is ignored. When omitted, the
       * host opens a file picker and imports the chosen file directly.
       */
      ids?: string[];
      settings?: ExportSettings;
      /**
       * How to resolve each imported AI endpoint whose id is already configured,
       * keyed by the id the **file** declared. The chosen providers themselves
       * travel in the host-side preview stash, never in this message, so a
       * credential the encrypted file carried stays in the extension host. An
       * absent strategy for a colliding id means `keep` (§10.1).
       */
      aiConflicts?: Record<string, ImportAiConflictStrategy>;
    }
  /** Drop the host's stashed import preview (user cancelled the preview). */
  | { command: 'cancelImportInstances' }
  | {
      command: 'checkIssueSubscription';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'changeIssueSubscription';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      user: string;
      subscribe: boolean;
    }
  | {
      command: 'startIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'stopIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'deleteIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'getUserStopwatches';
      instanceId: string;
    }
  | {
      command: 'getIssueTrackedTimes';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'addIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      time: number;
    }
  | {
      command: 'resetIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'deleteIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      id: number;
    }
  | {
      command: 'getIssueDependencies';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'createIssueDependency';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencyIndex: number;
    }
  | {
      command: 'removeIssueDependency';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencyIndex: number;
    }
  | {
      command: 'getIssueReactions';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'changeIssueReaction';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      content: string;
      add: boolean;
    }
  | {
      command: 'getCommentReactions';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
    }
  | {
      command: 'changeCommentReaction';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      content: string;
      add: boolean;
    }
  | {
      command: 'searchMentions';
      instanceId: string;
      owner: string;
      repo: string;
      query: string;
      type: 'user' | 'issue' | 'all';
      _requestId: string;
    }
  | {
      command: 'getUserPreview';
      instanceId: string;
      username: string;
      _requestId: string;
    }
  | {
      command: 'getIssuePreview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      _requestId: string;
    }
  | {
      command: 'submitPullReviewComment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      path: string;
      position: number;
      isBase: boolean;
      body: string;
      mode: 'single' | 'review';
      pendingReviewId?: number;
    }
  | {
      command: 'submitPullReview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId: number;
      event?: PullReviewSubmitEvent;
      body?: string;
    }
  | {
      command: 'deletePullReview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId: number;
    }
  | {
      command: 'pullReviewCommentDraftState';
      dirty: boolean;
    }
  | { command: 'closePullReviewCommentPanel' }
  // The pull-request-level entry point for the AI pre-review: the PR detail view
  // posts the coordinates of the pull request whose button was pressed, and the
  // host validates them and runs the very flow the `editor/title` button runs.
  //
  // The coordinates are the whole payload on purpose. The webview says **which
  // pull request** the user pointed at and nothing else: the model, the scope,
  // the prompt, the confirmation and the drafts are all the host's, so a modified
  // webview can start a review of a pull request it named, and cannot influence
  // what that review sends or writes. `instanceId` travels with them because the
  // dashboard is one webview for every configured instance and only the host can
  // resolve an instance id to a URL and a token.
  | { command: 'aiPreReviewPullRequest'; instanceId: string; owner: string; repo: string; index: number }
  // The AI pre-review panel's answers. It is the run's only write gate: `create`
  // names the cards the user checked **and the body each one is to be created
  // with** (the model's wording, or the user's edit of it), `cancel` (and closing
  // the tab, which the host turns into the same answer) writes nothing at all.
  //
  // The bodies are the one thing the webview may now propose, because the whole
  // point of the panel is to curate the proposal before it is written. The host
  // therefore re-validates every entry — the index must be one it offered, the
  // body a string that is non-empty after trimming and within
  // `PR_REVIEW_MAX_COMMENT_LENGTH` — and refuses the entire Create, creating
  // nothing, if any entry fails. Anchors, paths, sides and shas never appear in
  // this message and are still taken from the host's own payload.
  | { command: 'aiPreReviewPanelCreate'; entries: AiPreReviewPanelSelectedBody[] }
  | { command: 'aiPreReviewPanelCancel' }
  // The two non-decision actions: open one card's anchor in the diff, and reach
  // the pending review the run just created.
  | { command: 'aiPreReviewPanelOpenDiff'; index: number }
  | { command: 'aiPreReviewPanelOpenDraft' };
