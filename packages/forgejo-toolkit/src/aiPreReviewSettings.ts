import * as vscode from 'vscode';

/**
 * The host-side settings of the AI pre-review: two window-scoped switches (both
 * off by default) and one window-scoped model choice, kept in one module so the
 * readers that need them — the command that checks whether the feature may run
 * at all, the prompt builder that decides whether the diff body may leave the
 * machine, and the model listing that decides which provider receives it —
 * cannot drift apart.
 *
 * The reading discipline is `src/mcpWriteSettings.ts`'s: a hand-edited
 * `settings.json` can hold any JSON type under a key, a read that throws must
 * mean "off" rather than a failed activation, and only an explicit `true` may
 * enable a switch. The second switch is deliberately separate from the first
 * (the record's §7.1 option (a), which the maintainer chose): "I want this
 * feature" and "I agree to send this repository's code to a model provider" are
 * two different questions, and the answer to the second defaults to no.
 *
 * The third setting is the **chosen model**, and it is the single source of
 * truth for which model reviews a pull request: empty means "ask me", and a
 * non-empty value names the one model every run uses until the user changes it.
 * A value is parsed leniently (whitespace trimmed, comparison case-insensitive)
 * but **never guessed at**: a value that cannot be parsed, or that matches none
 * of the offered models, refuses the run instead of being silently ignored,
 * because the whole point of the setting is that the choice is the user's (see
 * the record's §7.2, "the model is the user's to choose"). The picker writes
 * the value it stores through `writeAiPreReviewModelSetting`, so the Settings
 * UI shows the choice and a hand-edited `settings.json` can change it.
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

/**
 * Which chat model may review a pull request. Window-scoped and empty by
 * default, and the only place the choice lives: with it empty a run **asks**
 * which model to use and stores the answer here, and with a value set every run
 * uses that one model without asking.
 */
export const AI_PRE_REVIEW_MODEL_SETTING = `${SETTINGS_SECTION}.aiPreReviewModel`;

/** The key without its section, for the `getConfiguration` read. */
const AI_PRE_REVIEW_KEY = 'aiPreReview';
const AI_PRE_REVIEW_INCLUDE_DIFF_KEY = 'aiPreReviewIncludeDiff';
const AI_PRE_REVIEW_MODEL_KEY = 'aiPreReviewModel';

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

/**
 * One model the user asked for, in the vocabulary `LanguageModelChatSelector`
 * uses. Every field is optional there; `vendor` is the one every accepted form
 * fills in, and exactly one of `family` / `id` is filled by the two accepted
 * forms — so "the selector matches this model" is always a conjunction of
 * `vendor` with the one part the user named.
 */
export interface AiPreReviewModelSelector {
  vendor: string;
  family?: string;
  id?: string;
  version?: string;
}

/**
 * The accepted forms of `forgejoToolkit.aiPreReviewModel`, and the reason the
 * parser is this small: the API's own selector vocabulary is the only thing the
 * value may mean, so the value is `vendor/family`, `vendor/id`, or either of
 * those with an `@version` suffix. Nothing else is a selector, and a value that
 * is not one is a typo.
 */
export const AI_PRE_REVIEW_MODEL_SELECTOR_FORMS = 'vendor/family, vendor/id (an optional @version suffix)';

/**
 * Parses `forgejoToolkit.aiPreReviewModel` into a selector, or `undefined` when
 * the text is not one.
 *
 * Lenient about the things a hand-typed setting is routinely wrong about and
 * that have exactly one sensible reading: surrounding whitespace and letter
 * case. Strict about everything else. There is no attempt to guess a mis-typed
 * `family` into an `id`, to drop an unknown extra segment, or to treat a bare
 * model name as a family — every one of those would send the brief to a
 * provider the user did not name, which is the failure this setting exists to
 * prevent. An unparseable value is reported by the caller together with the
 * models that are actually offered.
 *
 * The two accepted forms cannot be told apart syntactically (`family` and `id`
 * are both opaque strings), which is why the returned selector carries the
 * trailing part as **both** — an optional `family` and an optional `id` match
 * it either way, and a model that matches neither is simply not the model the
 * user named.
 */
export function parseAiPreReviewModelSelector(text: string): AiPreReviewModelSelector | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  // Exactly two parts: `vendor`, then the model name. Anything before the first
  // separator, or left over after the second, is a third thing the forms do not
  // have, and dropping it would be the guess this function refuses to make (see
  // `deepseek/flash/extra` and the `a/b@1@2/3` shape below).
  const parts = trimmed.split('/');
  if (parts.length !== 2) {
    return undefined;
  }
  const vendor = parts[0].trim();
  const rest = parts[1].trim();
  if (vendor === '' || rest === '') {
    return undefined;
  }
  // `@version` is split from the right: a family or id containing `@` keeps it,
  // and only the last `@` can be the version separator.
  const at = rest.lastIndexOf('@');
  const name = (at > 0 ? rest.slice(0, at) : rest).trim();
  const version = at > 0 ? rest.slice(at + 1).trim() : '';
  // `rest.startsWith('@')` (no name at all before the version) leaves `at === 0`
  // and a name that is not a name; nothing can match it, so it is refused here
  // rather than carried into a selectChatModels call.
  if (name === '' || name.startsWith('@') || (at > 0 && version === '')) {
    return undefined;
  }
  const selector: AiPreReviewModelSelector = {
    vendor: vendor.toLowerCase(),
    family: name.toLowerCase(),
    id: name.toLowerCase(),
  };
  if (version !== '') {
    selector.version = version.toLowerCase();
  }
  return selector;
}

/**
 * Whether the configured selector names this model. Case-insensitive on every
 * field for the same reason the parser is: the comparison is not the thing the
 * user is being asked to get exactly right.
 *
 * A `family` or `id` the selector leaves out constrains nothing, so this stays
 * correct whether the caller filled the trailing part as a `family`, as an
 * `id`, or as both.
 */
export function matchesAiPreReviewModelSelector(
  selector: AiPreReviewModelSelector,
  model: { vendor?: string; family?: string; id?: string; version?: string },
): boolean {
  if (!fieldMatches(selector.vendor, model.vendor) || !fieldMatches(selector.version, model.version)) {
    return false;
  }
  // The trailing part of the configured value is carried as both `family` and
  // `id` (see the parser), so the two are a disjunction rather than a
  // conjunction: the user named one string and it is either the family or the
  // id, and requiring both would match nothing whose family and id differ.
  const named = [selector.family, selector.id].filter((value): value is string => value !== undefined);
  if (named.length === 0) {
    return true;
  }
  return named.some((value) => fieldMatches(value, model.family) || fieldMatches(value, model.id));
}

/** One selector field against one model field; a missing constraint matches. */
function fieldMatches(constraint: string | undefined, value: string | undefined): boolean {
  if (constraint === undefined) {
    return true;
  }
  return typeof value === 'string' && value.trim().toLowerCase() === constraint;
}

/**
 * The configured model, as the user typed it, or `''` when the setting asks the
 * run to ask — or when reading it fails, which for this setting means the same
 * thing as "not configured": the run asks rather than guessing, so a
 * configuration read that throws cannot make the feature send anything to a
 * provider the user did not name.
 *
 * Returned raw rather than parsed so the caller can put the exact configured
 * text into a refusal message; `parseAiPreReviewModelSelector` is where the
 * accepted forms live.
 */
export function aiPreReviewModelSettingValue(): string {
  try {
    const value = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(AI_PRE_REVIEW_MODEL_KEY);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * One offered model as the setting would store it, or `undefined` when no
 * accepted form can name it.
 *
 * The stored value is the same `vendor/family` (or `vendor/id`) vocabulary a
 * hand-typed value uses, which is what keeps the picker's answer visible and
 * editable in the Settings UI. `id` is preferred over `family` because two
 * models of one provider can share a family — the family is a display grouping,
 * the id is the model — and storing the family would let the next run match the
 * *other* one, which is exactly the silent substitution this feature refuses to
 * make. A part that cannot round-trip through
 * `parseAiPreReviewModelSelector` — empty, containing a second `/`, or carrying
 * an `@` that would be read as a version separator — disqualifies that part, and
 * a model no part can name returns `undefined` rather than a value that would
 * not match it on the next run.
 */
export function formatAiPreReviewModelSettingValue(model: {
  vendor?: string;
  family?: string;
  id?: string;
}): string | undefined {
  const vendor = (model.vendor ?? '').trim();
  if (vendor === '') {
    return undefined;
  }
  for (const part of [model.id, model.family]) {
    const name = (part ?? '').trim();
    if (name === '') {
      continue;
    }
    const value = `${vendor}/${name}`;
    if (parseAiPreReviewModelSelector(value) !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Writes one model choice into `forgejoToolkit.aiPreReviewModel` at **global**
 * scope: the choice is the user's, so it has to be the same value in the
 * Settings UI, in `settings.json`, and in every later run — not a hidden
 * in-memory preference this extension keeps for itself.
 *
 * A failed write is the caller's to report: the run has already been told which
 * model to use, so the failure changes where the choice is remembered, never
 * which model reviews this pull request.
 */
export async function writeAiPreReviewModelSetting(value: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .update(AI_PRE_REVIEW_MODEL_KEY, value, vscode.ConfigurationTarget.Global);
}
