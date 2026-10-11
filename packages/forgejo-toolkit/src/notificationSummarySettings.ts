import * as vscode from 'vscode';
import {
  NOTIFICATION_SUMMARY_PROMPT_SCOPES,
  type NotificationSummaryPromptScopeValue,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The host-side settings of the notification-summary feature: one feature switch (off by
 * default) and one **prompt scope**, in one module for the reason
 * `src/prDescriptionSettings.ts` gives for its own pair — the reader that decides whether
 * the feature may run and the run that decides what may leave the machine read the same two
 * keys, and two readers of one key drift apart.
 *
 * The consent shape is `docs/design/notification-summary.md` §5, and it inherits
 * `docs/design/ai-model-transport.md` §7.6's rule that every feature owns its scope value:
 * this one sends **someone else's prose**, which no other feature sends, so "how much of a
 * discussion may leave" has to be its own answer rather than a value shared with the
 * pre-review or the draft generator.
 *
 * Both keys are machine-scoped in the manifest (2026-10-07 ruling, `settings-page.md` §3.5):
 * one of them decides whether the feature may run at all and the other decides whether a
 * run sends the opening post alone or every comment, so a workspace must not be able to
 * switch it on or widen it.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * Whether the notification-summary feature may run in this window at all.
 *
 * Default off, like the other three features: with it off the action is not offered and a
 * stale one refuses before the timeline is read, so no discussion and no model call is
 * involved.
 */
export const NOTIFICATION_SUMMARY_SETTING = `${SETTINGS_SECTION}.notificationSummary`;

/**
 * What one summary's prompt may carry. The default is the **question**, not an answer: with
 * `ask` a run shows one modal, sends nothing and writes nothing before the answer.
 */
export const NOTIFICATION_SUMMARY_PROMPT_SCOPE_SETTING = `${SETTINGS_SECTION}.notificationSummaryPromptScope`;

/**
 * The values of `forgejoToolkit.notificationSummaryPromptScope`, in the order the manifest's
 * dropdown, the settings page's dropdown and the consent modal show them.
 *
 * Defined in the shared package and re-exported here because the page renders the same
 * values with its own control: one enumeration for the reader, the writer and the page, so a
 * value one of them cannot name cannot exist. `ask` is first because it is the default and
 * the only value that sends nothing on its own.
 */
export { NOTIFICATION_SUMMARY_PROMPT_SCOPES };

/** One value of `forgejoToolkit.notificationSummaryPromptScope`. */
export type NotificationSummaryPromptScope = NotificationSummaryPromptScopeValue;

/**
 * One scope the user **stated** — every value but `ask`. Only one of these may start a run,
 * and only one of these may be written into the setting: writing `ask` back would turn a
 * stated choice into a question again.
 */
export type NotificationSummaryStatedScope = Exclude<NotificationSummaryPromptScope, 'ask'>;

/** The key without its section, for the `getConfiguration` read. */
const NOTIFICATION_SUMMARY_KEY = 'notificationSummary';
const NOTIFICATION_SUMMARY_PROMPT_SCOPE_KEY = 'notificationSummaryPromptScope';

/** Reads one boolean switch, treating anything but an explicit `true` as off. */
function readBooleanSwitch(key: string): boolean {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>(key, false) === true;
  } catch {
    // A configuration read that throws must mean "off", never a failed activation — and for
    // this pair, "off" is the direction that reads no discussion and sends nothing.
    return false;
  }
}

/**
 * Whether the notification-summary feature is enabled. Read fresh on every request: turning
 * the switch off in a running window takes effect for the next one without a reload.
 */
export function isNotificationSummaryEnabled(): boolean {
  return readBooleanSwitch(NOTIFICATION_SUMMARY_KEY);
}

/** Whether the text is one of the contributed values, case-insensitively. */
function isNotificationSummaryPromptScope(value: string): value is NotificationSummaryPromptScope {
  return (NOTIFICATION_SUMMARY_PROMPT_SCOPES as readonly string[]).includes(value);
}

/**
 * The configured prompt scope, or `ask` when nothing usable is configured.
 *
 * `ask` is the reading for every "we do not know": an absent value, a value the manifest does
 * not contribute (a typo, or a leftover from a future version), a non-string, and a read that
 * throws. That is the fail-closed direction — `ask` sends nothing on its own and asks the one
 * question — so a broken `settings.json` can never make a run send someone else's prose that
 * the user never agreed to.
 *
 * Surrounding whitespace and letter case are ignored for the same reason the other features'
 * scopes ignore them: the comparison is not the thing the user is being asked to get exactly
 * right.
 */
export function notificationSummaryPromptScopeSettingValue(): NotificationSummaryPromptScope {
  try {
    const value = vscode.workspace
      .getConfiguration(SETTINGS_SECTION)
      .get<unknown>(NOTIFICATION_SUMMARY_PROMPT_SCOPE_KEY);
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return isNotificationSummaryPromptScope(text) ? text : 'ask';
  } catch {
    return 'ask';
  }
}

/**
 * Writes the scope the user just chose into `forgejoToolkit.notificationSummaryPromptScope`
 * at **global** scope, for exactly the reasons the other features' writers give: the answer
 * is the user's, it has to be visible and editable in the Settings UI, and every later run
 * has to find it — not a window's memory of a dialog.
 *
 * Only a **stated** scope may be written: `ask` is the question, so writing it back would
 * make the next run ask again and lose the answer that was just given.
 *
 * A failed write is the caller's to report: the run has already been told what may be sent,
 * so the failure changes where the answer is remembered, never what this run sends.
 */
export async function writeNotificationSummaryPromptScopeSetting(scope: NotificationSummaryStatedScope): Promise<void> {
  await vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .update(NOTIFICATION_SUMMARY_PROMPT_SCOPE_KEY, scope, vscode.ConfigurationTarget.Global);
}
