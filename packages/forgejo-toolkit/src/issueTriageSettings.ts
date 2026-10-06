import * as vscode from 'vscode';
import {
  ISSUE_TRIAGE_PROMPT_SCOPES,
  type IssueTriagePromptScopeValue,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The host-side settings of issue triage: one feature switch (off by default) and
 * one **prompt scope**, kept in one module for the reason `src/prDescriptionSettings.ts`
 * gives for its own pair — the run that decides whether the feature may run and the
 * run that decides what may leave the machine read the same two keys, and two
 * readers of one key drift apart.
 *
 * The consent shape is the one `docs/design/ai-model-transport.md` §7.6 states and
 * the other features follow; this feature's own decisions are in
 * `docs/design/issue-triage.md`. Three of them are why this file looks the way it
 * does:
 *
 * 1. **The scope is this feature's own value**, not the pre-review's five or the
 *    description's four: the bytes each answer sends are different here (the issue's
 *    own text plus the repository's **label list**, and optionally the discussion),
 *    and one value must mean one thing.
 * 2. **Both settings are `machine`-scoped** (the manifest side lives in
 *    `package.json`; `src/webview/settingsSurface.ts` holds the list the drift
 *    guard checks it against). A workspace-level `.vscode/settings.json` could
 *    otherwise turn this feature on, or widen its egress to the discussion, for a
 *    repository the user opened — the same argument §8.3 makes for the endpoint
 *    settings, and the reason this feature's pair is stricter than the two AI
 *    features that shipped before it.
 * 3. **The reading discipline is `src/mcpWriteSettings.ts`'s**: a hand-edited
 *    `settings.json` can hold any JSON type under a key, a read that throws must
 *    mean the closed direction rather than a failed activation, and only an
 *    explicit `true` may enable the switch.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * Whether issue triage may run in this window at all.
 *
 * Default off, like the other AI features: with it off the action refuses before
 * it reads the issue, so no issue text, no label list and no comment is involved.
 */
export const ISSUE_TRIAGE_SETTING = `${SETTINGS_SECTION}.issueTriage`;

/**
 * What one run's prompt may carry. An `ask` default for the same reason the other
 * features have one: it is the question, not an answer.
 */
export const ISSUE_TRIAGE_PROMPT_SCOPE_SETTING = `${SETTINGS_SECTION}.issueTriagePromptScope`;

/**
 * The values of `forgejoToolkit.issueTriagePromptScope`, in the order the
 * manifest's dropdown and the settings page show them.
 *
 * Defined in the shared package and re-exported here because the settings page
 * renders the same values with its own control: one enumeration for the reader, the
 * writer and the page, so a value one of them cannot name cannot exist.
 */
export { ISSUE_TRIAGE_PROMPT_SCOPES };

/** One value of `forgejoToolkit.issueTriagePromptScope`. */
export type IssueTriagePromptScope = IssueTriagePromptScopeValue;

/**
 * One scope the user **stated** — every value but `ask`. Only one of these may
 * start a run, and only one of these may be written into the setting: writing
 * `ask` back would turn a stated choice into a question again.
 */
export type IssueTriageStatedScope = Exclude<IssueTriagePromptScope, 'ask'>;

/** The keys without their section, for the `getConfiguration` reads. */
const ISSUE_TRIAGE_KEY = 'issueTriage';
const ISSUE_TRIAGE_PROMPT_SCOPE_KEY = 'issueTriagePromptScope';

/** Reads one boolean switch, treating anything but an explicit `true` as off. */
function readBooleanSwitch(key: string): boolean {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>(key, false) === true;
  } catch {
    // A configuration read that throws must mean "off", never a failed activation
    // — and for this pair, "off" is the direction that sends nothing.
    return false;
  }
}

/**
 * Whether issue triage is enabled. Read fresh on every request: turning the switch
 * off in a running window takes effect for the next one without a reload.
 */
export function isIssueTriageEnabled(): boolean {
  return readBooleanSwitch(ISSUE_TRIAGE_KEY);
}

/** Whether the text is one of the contributed values. */
function isIssueTriagePromptScope(value: string): value is IssueTriagePromptScope {
  return (ISSUE_TRIAGE_PROMPT_SCOPES as readonly string[]).includes(value);
}

/**
 * The configured prompt scope, or `ask` when nothing usable is configured.
 *
 * `ask` is the reading for every "we do not know": an absent value, a value the
 * manifest does not contribute, a non-string, and a read that throws. That is the
 * fail-closed direction for this setting — `ask` sends nothing on its own and asks
 * the one question — so a broken `settings.json` can never make a run send the
 * discussion the user never agreed to.
 */
export function issueTriagePromptScopeSettingValue(): IssueTriagePromptScope {
  try {
    const value = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(ISSUE_TRIAGE_PROMPT_SCOPE_KEY);
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return isIssueTriagePromptScope(text) ? text : 'ask';
  } catch {
    return 'ask';
  }
}

/**
 * Writes the scope the user just chose into
 * `forgejoToolkit.issueTriagePromptScope` at **global** scope, for exactly the
 * reasons the other features' writers give: the answer is the user's, it has to be
 * visible and editable in the Settings UI, and every later run has to find it — not
 * a window's memory of a dialog.
 *
 * Only a **stated** scope may be written: `ask` is the question, so writing it back
 * would make the next run ask again and lose the answer that was just given.
 *
 * A failed write is the caller's to report: the run has already been told what may
 * be sent, so the failure changes where the answer is remembered, never what this
 * run sends.
 */
export async function writeIssueTriagePromptScopeSetting(scope: IssueTriageStatedScope): Promise<void> {
  await vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .update(ISSUE_TRIAGE_PROMPT_SCOPE_KEY, scope, vscode.ConfigurationTarget.Global);
}

/**
 * The surface one triage run starts from.
 *
 * A named type rather than a bare string because which scopes are honourable is a
 * property of the surface, and the run has to be able to say "not here" instead of
 * substituting another tier (`docs/design/issue-triage.md` §3.1).
 */
export type IssueTriageSurface = 'issue-detail';

/**
 * The stated scopes that surface can honour.
 *
 * Today there is one surface and it can honour both: the discussion is a read on
 * that same page, so `issue-and-comments` needs nothing the page cannot get. The
 * function exists so that this is a **fact the code states** rather than an
 * assumption the consent modal and the run each make: the modal offers exactly the
 * answers this returns, and a stated scope outside it fails by name instead of
 * running with less than the user chose (the description feature's rule, §3.1).
 */
export function issueTriageScopesForSurface(surface: IssueTriageSurface): readonly IssueTriageStatedScope[] {
  return surface === 'issue-detail' ? ['issue-only', 'issue-and-comments'] : [];
}

/** Whether one stated scope can be honoured on one surface. */
export function issueTriageScopeHonourableOn(surface: IssueTriageSurface, scope: IssueTriageStatedScope): boolean {
  return issueTriageScopesForSurface(surface).includes(scope);
}
