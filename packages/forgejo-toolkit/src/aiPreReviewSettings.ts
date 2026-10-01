import * as vscode from 'vscode';

/**
 * The host-side settings of the AI pre-review. Two window-scoped switches, both
 * off by default, kept in one module so the two readers that need them — the
 * command that checks whether the feature may run at all, and the prompt
 * builder that decides whether the diff body may leave the machine — cannot
 * drift apart.
 *
 * The reading discipline is `src/mcpWriteSettings.ts`'s: a hand-edited
 * `settings.json` can hold any JSON type under a key, a read that throws must
 * mean "off" rather than a failed activation, and only an explicit `true` may
 * enable a switch. The second switch is deliberately separate from the first
 * (the record's §7.1 option (a), which the maintainer chose): "I want this
 * feature" and "I agree to send this repository's code to a model provider" are
 * two different questions, and the answer to the second defaults to no.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/** Whether the AI pre-review feature may run in this window at all. */
export const AI_PRE_REVIEW_SETTING = `${SETTINGS_SECTION}.aiPreReview`;

/**
 * Whether the prompt may carry the diff body itself (the changed lines), not
 * just the file table. Off by default: the diff body is the source code, and
 * sending it is a decision about the user's relationship with the provider, not
 * one this extension makes for them.
 */
export const AI_PRE_REVIEW_INCLUDE_DIFF_SETTING = `${SETTINGS_SECTION}.aiPreReviewIncludeDiff`;

/** The key without its section, for the `getConfiguration` read. */
const AI_PRE_REVIEW_KEY = 'aiPreReview';
const AI_PRE_REVIEW_INCLUDE_DIFF_KEY = 'aiPreReviewIncludeDiff';

/** Reads one boolean switch, treating anything but an explicit `true` as off. */
function readBooleanSwitch(key: string): boolean {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>(key, false) === true;
  } catch {
    // A configuration read that throws must mean "off", never a failed
    // activation — and for this pair, "off" is the direction that sends nothing.
    return false;
  }
}

/**
 * Whether the AI pre-review is enabled. Read fresh on every command
 * invocation: turning the switch off in a running window takes effect for the
 * next invocation without a reload.
 */
export function isAiPreReviewEnabled(): boolean {
  return readBooleanSwitch(AI_PRE_REVIEW_KEY);
}

/**
 * Whether the prompt may include the diff body. Only consulted when the feature
 * switch is on, and only as a second gate: with it off the model still gets the
 * changed-file table, which is the behaviour the record's §7.1 decided.
 */
export function isAiPreReviewIncludeDiffEnabled(): boolean {
  return readBooleanSwitch(AI_PRE_REVIEW_INCLUDE_DIFF_KEY);
}
