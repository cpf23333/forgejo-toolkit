import * as vscode from 'vscode';
import {
  PR_DESCRIPTION_PROMPT_SCOPES,
  type PrDescriptionPromptScopeValue,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The host-side settings of the PR-description feature: one feature switch (off by
 * default) and one **prompt scope**, kept in one module for the reason
 * `src/aiPreReviewSettings.ts` gives for its own pair — the command that decides
 * whether the feature may run and the run that decides what may leave the machine
 * read the same two keys, and two readers of one key drift apart.
 *
 * The consent shape is `docs/design/ai-model-transport.md` §7.6, and it is the
 * pre-review's shape rather than the pre-review's **value**: the scope is a
 * setting of this feature's own because the two features send different content
 * at different moments (§7.6 says why sharing one value is wrong), while the
 * reading discipline is `src/mcpWriteSettings.ts`'s — a hand-edited
 * `settings.json` can hold any JSON type under a key, a read that throws must mean
 * the closed direction rather than a failed activation, and only an explicit
 * `true` may enable the switch.
 *
 * The scope's default is the **question**, not an answer: `ask` sends nothing on
 * its own, and a run that reads it shows one modal, sends nothing and writes
 * nothing before the answer.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * Whether the PR-description feature may run in this window at all.
 *
 * Default off, like `forgejoToolkit.aiPreReview`: with it off the generate action
 * refuses before it reads the comparison, so no diff, no commit list and no model
 * call is involved.
 */
export const PR_DESCRIPTION_SETTING = `${SETTINGS_SECTION}.prDescription`;

/**
 * What one draft's prompt may carry. An `ask` default for the same reason the
 * pre-review's scope has one: it is the question, not an answer.
 */
export const PR_DESCRIPTION_PROMPT_SCOPE_SETTING = `${SETTINGS_SECTION}.prDescriptionPromptScope`;

/**
 * The values of `forgejoToolkit.prDescriptionPromptScope`, in the order the
 * manifest's dropdown and the consent modal show them.
 *
 * Defined in the shared package and re-exported here because the settings page
 * renders the same values with its own control: one enumeration for the reader,
 * the writer and the page, so a value one of them cannot name cannot exist.
 *
 * `ask` is first because it is the default and the only value that sends nothing
 * on its own; the two after it are the answers, in the order of how much leaves
 * the machine.
 */
export { PR_DESCRIPTION_PROMPT_SCOPES };

/** One value of `forgejoToolkit.prDescriptionPromptScope`. */
export type PrDescriptionPromptScope = PrDescriptionPromptScopeValue;

/**
 * One scope the user **stated** — every value but `ask`. Only one of these may
 * start a run, and only one of these may be written into the setting: writing
 * `ask` back would turn a stated choice into a question again.
 */
export type PrDescriptionStatedScope = Exclude<PrDescriptionPromptScope, 'ask'>;

/**
 * The one stated scope that reads the pull request's **own diff**, and therefore
 * needs a pull request that already exists (`docs/design/ai-pr-description.md`
 * §3.1).
 *
 * It is a constant rather than a string spelled at each use because three places
 * have to agree on which tier that is: the run that decides whether it can honour
 * the configured answer, the host's own answer to "may the create form offer the
 * control", and the sentence that refusal shows. A second spelling would let one
 * of them drift into refusing (or offering) the wrong scope.
 */
export const PR_DESCRIPTION_EXISTING_PULL_REQUEST_SCOPE: PrDescriptionStatedScope = 'commits-and-diff';

/**
 * Whether a stated scope can only be honoured where a pull request already
 * exists.
 *
 * The `commits-and-diff` tier drafts from `getPullRequestDiff(owner, repo, index)`
 * — the platform's own whole-pull-request diff — so a surface whose pull request
 * does not exist yet cannot serve it. The other two stated scopes are built from
 * the comparison of two branch names, which both surfaces have.
 */
export function prDescriptionScopeNeedsExistingPullRequest(scope: PrDescriptionStatedScope): boolean {
  return scope === PR_DESCRIPTION_EXISTING_PULL_REQUEST_SCOPE;
}

/**
 * Whether the **create** form may offer its "Generate description" control right
 * now: the feature is on, and the configured answer is one that comparison can
 * serve.
 *
 * `ask` counts as honourable here on purpose: the modal the create surface shows
 * offers only the answers it can serve, so the question itself is answerable
 * there. A **stated** `commits-and-diff` is not: the host does not silently
 * substitute another tier (that would send bytes the user did not choose), so the
 * control is not offered and the run — reachable anyway through a stale webview or
 * a hand-edited message — refuses by name.
 *
 * This is the affordance half only. The run reads the settings itself and is the
 * gate.
 */
export function prDescriptionOfferedOnCreateForm(): boolean {
  if (!isPrDescriptionEnabled()) {
    return false;
  }
  const scope = prDescriptionPromptScopeSettingValue();
  return scope === 'ask' || !prDescriptionScopeNeedsExistingPullRequest(scope);
}

/** The key without its section, for the `getConfiguration` read. */
const PR_DESCRIPTION_KEY = 'prDescription';
const PR_DESCRIPTION_PROMPT_SCOPE_KEY = 'prDescriptionPromptScope';

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
 * Whether the PR-description feature is enabled. Read fresh on every request:
 * turning the switch off in a running window takes effect for the next one
 * without a reload.
 */
export function isPrDescriptionEnabled(): boolean {
  return readBooleanSwitch(PR_DESCRIPTION_KEY);
}

/** Whether the text is one of the contributed values, case-insensitively. */
function isPrDescriptionPromptScope(value: string): value is PrDescriptionPromptScope {
  return (PR_DESCRIPTION_PROMPT_SCOPES as readonly string[]).includes(value);
}

/**
 * The configured prompt scope, or `ask` when nothing usable is configured.
 *
 * `ask` is the reading for every "we do not know": an absent value, a value the
 * manifest does not contribute (a typo, or a leftover from a future version), a
 * non-string, and a read that throws. That is the fail-closed direction for this
 * setting — `ask` sends nothing on its own and asks the one question — so a broken
 * `settings.json` can never make a draft send content the user never agreed to.
 *
 * Surrounding whitespace and letter case are ignored for the same reason the
 * pre-review's scope ignores them: the comparison is not the thing the user is
 * being asked to get exactly right.
 */
export function prDescriptionPromptScopeSettingValue(): PrDescriptionPromptScope {
  try {
    const value = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(PR_DESCRIPTION_PROMPT_SCOPE_KEY);
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return isPrDescriptionPromptScope(text) ? text : 'ask';
  } catch {
    return 'ask';
  }
}

/**
 * Writes the scope the user just chose into
 * `forgejoToolkit.prDescriptionPromptScope` at **global** scope, for exactly the
 * reasons the pre-review's writer gives: the answer is the user's, it has to be
 * visible and editable in the Settings UI, and every later run has to find it —
 * not a window's memory of a dialog.
 *
 * Only a **stated** scope may be written: `ask` is the question, so writing it
 * back would make the next run ask again and lose the answer that was just given.
 *
 * A failed write is the caller's to report: the run has already been told what may
 * be sent, so the failure changes where the answer is remembered, never what this
 * run sends.
 */
export async function writePrDescriptionPromptScopeSetting(scope: PrDescriptionStatedScope): Promise<void> {
  await vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .update(PR_DESCRIPTION_PROMPT_SCOPE_KEY, scope, vscode.ConfigurationTarget.Global);
}
