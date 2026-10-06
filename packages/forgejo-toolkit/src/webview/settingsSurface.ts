import * as vscode from 'vscode';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  ISSUE_TRIAGE_PROMPT_SCOPES,
  PR_DESCRIPTION_PROMPT_SCOPES,
  SETTINGS_SURFACE_WRITABLE_KEYS,
  type AiPreReviewPromptScopeValue,
  type IssueTriagePromptScopeValue,
  type PrDescriptionPromptScopeValue,
  type SettingsSourceLevel,
  type SettingsSurfaceSnapshot,
  type SettingsSurfaceWritableKey,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS,
  NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS,
} from '@cpf23333-forgejo-toolkit/shared/limits';
import { aiEnabledSettingValue } from '../ai/modelSettings';
import { aiPreReviewPromptScopeSettingValue, isAiPreReviewEnabled } from '../aiPreReviewSettings';
import { isPrDescriptionEnabled, prDescriptionPromptScopeSettingValue } from '../prDescriptionSettings';
import { isIssueTriageEnabled, issueTriagePromptScopeSettingValue } from '../issueTriageSettings';
import { enabledMcpWriteTools, isMcpWriteAuditToFileEnabled, MCP_WRITE_TOOLS_KEY } from '../mcpWriteSettings';
import { isMcpServerEnabled } from '../mcpServerProvider';
import { isMultiWindowLeaseEnabled } from '../lease/leaseSupervisor';
import { MCP_WRITE_TOOL_SETTING_KEYS, type McpWriteTool } from '../../mcp/writeTools';
import { logger } from '../logger';

/**
 * The settings page's own surface: how the settings it renders are read and
 * written, and which of them VS Code cannot let a workspace override
 * (`docs/design/settings-page.md` §1.3, §3.2, §3.5, §6).
 *
 * The page and this module are one surface seen from two sides: it renders a
 * control for every setting the manifest contributes, and this module is the only
 * place a write from it is accepted. Which settings those are is the webview
 * string catalogue's answer (`en.json`'s `settings["forgejoToolkit.…"]` keys),
 * held against the manifest by `src/__tests__/settingsSurface.test.ts`; there is
 * deliberately no second list here of settings that stay native, because none do
 * — every contributed setting has a control on that page now (§1.3, §6).
 *
 * The reads reuse the **feature readers** the behaviours themselves use
 * (`isMcpServerEnabled`, `enabledMcpWriteTools`, `isMcpWriteAuditToFileEnabled`,
 * `isMultiWindowLeaseEnabled`, `aiEnabledSettingValue`, `isAiPreReviewEnabled`,
 * `aiPreReviewPromptScopeSettingValue`), so the page cannot claim a switch is on
 * while the feature reads it off. The two exceptions are the notification poller
 * and the mock switch, whose readers live on `ConfigManager` (it owns those
 * settings); they are passed in as dependencies for the same reason: one reading,
 * not two.
 *
 * Writes go to **global** scope, matching every other control this page has
 * (`setLocale`, `setDebug`, `setWorktreeOpenMode`, the AI model policy): the page
 * edits the user's own settings, and a workspace-level override stays what it is.
 * That is why every write is followed by a fresh read and the reply carries the
 * value that is actually in effect — and why the reading also says which **level**
 * that value came from: a workspace value beats the one this page writes, so
 * without that fact a click on an overridden control looks like it did nothing
 * (§3.5). The page writes the user level and reads the source; it never writes a
 * second scope, and the workspace level is the only one above its own that the
 * reading can report.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * The settings the manifest declares at **`machine` scope**, as full setting ids.
 *
 * A machine-scoped setting cannot be overridden: VS Code applies only a user
 * (machine) value to one, so a value hand-written into `.vscode/settings.json`
 * never becomes the effective one. The page therefore must not claim a workspace
 * value wins for one of these, and the source reading below never reports a level
 * above `user` for a key in this list (§3.5).
 *
 * It is written out rather than derived because the manifest's scope is not part
 * of any runtime reading, and it is a **complete** list rather than only the keys
 * this snapshot happens to carry: the drift guard
 * (`src/__tests__/settingsSurface.test.ts`) holds it against every
 * `"scope": "machine"` property in the manifest, so the day one is added to, or
 * removed from, the AI family the guard says so.
 */
export const MACHINE_SCOPED_SETTING_KEYS: readonly string[] = [
  'forgejoToolkit.aiEnabled',
  // The per-feature switches, their prompt scopes and the pre-review's model choice
  // are machine-scoped too (the maintainer's ruling of 2026-10-06): each of them
  // decides whether content may leave the machine, how much of it, or which provider
  // receives it, so a workspace-level value must not be able to change one behind the
  // reader's back (`docs/design/settings-page.md` §3.5).
  'forgejoToolkit.aiPreReview',
  'forgejoToolkit.aiPreReviewPromptScope',
  'forgejoToolkit.aiPreReviewModel',
  'forgejoToolkit.prDescription',
  'forgejoToolkit.prDescriptionPromptScope',
  'forgejoToolkit.issueTriage',
  'forgejoToolkit.issueTriagePromptScope',
  'forgejoToolkit.aiProviders',
  'forgejoToolkit.aiTransport',
  'forgejoToolkit.aiDefaultProvider',
  'forgejoToolkit.aiDefaultModel',
  'forgejoToolkit.aiModelBindings',
  'forgejoToolkit.aiModelRequestTimeoutMs',
];

/** What one host-side read of the surface needs from its caller. */
export interface SettingsSurfaceReadDeps {
  /**
   * `ConfigManager.isNotificationPollingEnabled`: the same reading the poller
   * itself obeys, so the switch on the page cannot disagree with the behaviour.
   */
  isNotificationPollingEnabled: () => boolean;
  /**
   * `ConfigManager.getNotificationPollingInterval`: the poller's own clamped
   * reading, so the field shows the interval that is actually being used rather
   * than a value out of the store the loop would never obey.
   */
  getNotificationPollingInterval: () => number;
  /**
   * `ConfigManager.isMockApiEnabled`: the reading `extension.ts` makes its own
   * activation decision from, so the developer switch cannot show a state the
   * mock server was not started under.
   */
  isMockApiEnabled: () => boolean;
}

/** Whether a value is one of the keys the page may write. */
export function isSettingsSurfaceWritableKey(value: unknown): value is SettingsSurfaceWritableKey {
  return typeof value === 'string' && (SETTINGS_SURFACE_WRITABLE_KEYS as readonly string[]).includes(value);
}

/** The key's name without the section prefix `inspect`/`update` take it under. */
function settingKeyName(fullKey: string): string {
  return fullKey.slice(`${SETTINGS_SECTION}.`.length);
}

/**
 * The level one setting's effective value comes from, as `inspect` reports it.
 *
 * The order is VS Code's own precedence — workspace over user over default — and
 * a level counts only when it holds a value, which is what tells "this level set
 * it" from "it was never set here". Language-scoped values
 * (`globalLanguageValue` and its siblings) are deliberately not consulted: the
 * levels this page names are the levels these settings are scoped to, and a
 * per-language override of one of them is not a state the page has wording for.
 *
 * There is no `workspaceFolder` reading, on purpose. This configuration is read
 * without a resource URI, so `inspect().workspaceFolderValue` is always
 * `undefined` here, and these settings are window-scoped, so the editor does not
 * apply a folder value to them anyway: a marker for that level would claim an
 * override that does not exist, exactly the case `machine`-scoped keys skip
 * below. Adding it back means reading with a `scopeUri`
 * (`workspace.getConfiguration(SETTINGS_SECTION, folderUri)`) as well, which is
 * what §3.5 of the design record says.
 *
 * A machine-scoped key skips the workspace level: the editor does not apply a
 * workspace value to it, so reporting one would make the page tell the reader
 * that a setting wins which does not (§3.5).
 */
function readSettingSourceLevel(config: vscode.WorkspaceConfiguration, fullKey: string): SettingsSourceLevel {
  const inspected = config.inspect(settingKeyName(fullKey));
  if (inspected === undefined) {
    return 'default';
  }
  if (!MACHINE_SCOPED_SETTING_KEYS.includes(fullKey)) {
    if (inspected.workspaceValue !== undefined) {
      return 'workspace';
    }
  }
  return inspected.globalValue !== undefined ? 'user' : 'default';
}

/**
 * The level every setting this snapshot presents comes from, in the order of
 * `SETTINGS_SURFACE_WRITABLE_KEYS`.
 *
 * The map is total: every writable key gets an entry, so the page can tell "this
 * level is not the user's" from "nothing was said about this key". It is built
 * from one `getConfiguration` call, and it reads the settings themselves, not a
 * value: the values come from the feature readers, which is why nothing here
 * duplicates a default or a coercion rule.
 */
function readSettingSources(): Record<SettingsSurfaceWritableKey, SettingsSourceLevel> {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return Object.fromEntries(
    SETTINGS_SURFACE_WRITABLE_KEYS.map((key) => [key, readSettingSourceLevel(config, key)]),
  ) as Record<SettingsSurfaceWritableKey, SettingsSourceLevel>;
}

/** Reads the settings the page's own sections present. */
export function readSettingsSurface(deps: SettingsSurfaceReadDeps): SettingsSurfaceSnapshot {
  const enabledWriteTools = enabledMcpWriteTools();
  return {
    notificationPollingEnabled: deps.isNotificationPollingEnabled(),
    notificationPollingInterval: deps.getNotificationPollingInterval(),
    useMockApi: deps.isMockApiEnabled(),
    mcpEnabled: isMcpServerEnabled(),
    mcpWriteTools: {
      createIssueComment: enabledWriteTools.includes('create_issue_comment'),
      submitPullReview: enabledWriteTools.includes('submit_pull_review'),
      cancelActionRun: enabledWriteTools.includes('cancel_action_run'),
    },
    mcpWriteAuditToFile: isMcpWriteAuditToFileEnabled(),
    multiWindowLease: isMultiWindowLeaseEnabled(),
    aiEnabled: aiEnabledSettingValue(),
    aiPreReview: isAiPreReviewEnabled(),
    aiPreReviewPromptScope: aiPreReviewPromptScopeSettingValue(),
    prDescription: isPrDescriptionEnabled(),
    prDescriptionPromptScope: prDescriptionPromptScopeSettingValue(),
    issueTriage: isIssueTriageEnabled(),
    issueTriagePromptScope: issueTriagePromptScopeSettingValue(),
    sources: readSettingSources(),
  };
}

/** The result of one write: nothing to say, or the host's own sentence. */
export type SettingsSurfaceWriteResult = { ok: true } | { ok: false; error: string };

/** Writes one setting at global scope. */
async function writeSettingValue(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

/** The three per-tool switches, by the write tool each one gates. */
const WRITE_TOOL_BY_SETTING: Readonly<Record<string, McpWriteTool>> = {
  'forgejoToolkit.mcpWriteTools.createIssueComment': 'create_issue_comment',
  'forgejoToolkit.mcpWriteTools.submitPullReview': 'submit_pull_review',
  'forgejoToolkit.mcpWriteTools.cancelActionRun': 'cancel_action_run',
};

/**
 * Stores one per-tool write switch as **its own dotted key**.
 *
 * The manifest contributes the three tools as three dotted keys
 * (`forgejoToolkit.mcpWriteTools.createIssueComment`, …) and **no**
 * `forgejoToolkit.mcpWriteTools` property — the settings section §1.3 states that
 * outright. A write to the container is therefore refused by the editor as an
 * unregistered setting, which is what a live walkthrough hit on all three
 * switches; the write has to address the same key the manifest declares.
 *
 * Writing the one dotted key is also what makes "a tool nobody here knows about
 * survives" true by construction: `update` merges into the object, and this page
 * never writes the neighbour keys at all. The current value is read the way the
 * feature readers read it (`enabledMcpWriteTools`: only an explicit `true` is
 * on), and a switch that already holds the requested value is not written again.
 */
async function writeMcpWriteTool(key: string, value: boolean): Promise<void> {
  const tool = WRITE_TOOL_BY_SETTING[key];
  if (tool === undefined) {
    throw new Error(`"${key}" is not a write-tool setting`);
  }
  if (enabledMcpWriteTools().includes(tool) === value) {
    return;
  }
  await writeSettingValue(`${MCP_WRITE_TOOLS_KEY}.${MCP_WRITE_TOOL_SETTING_KEYS[tool]}`, value);
}

/**
 * Writes one setting the page renders, after validating it as untrusted input.
 *
 * The webview is not trusted with more than the page can send: the key has to be
 * one the page owns, and the value has to be the type that key takes. A value that
 * does not fit is refused with a sentence that names the setting and the shape it
 * takes — and **never** the value itself, because a forged message could put a
 * credential in the field and the refusal would then print it into the UI and the
 * log.
 */
export async function writeSettingsSurfaceValue(
  rawKey: unknown,
  rawValue: unknown,
): Promise<SettingsSurfaceWriteResult> {
  if (!isSettingsSurfaceWritableKey(rawKey)) {
    logger.error('setSettingsSurfaceValue refused a key that is not part of the settings page surface');
    return {
      ok: false,
      error: vscode.l10n.t('That setting cannot be written from this page.'),
    };
  }
  const key = rawKey;
  try {
    if (key === 'forgejoToolkit.aiPreReviewPromptScope') {
      const scope = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!(AI_PRE_REVIEW_PROMPT_SCOPES as readonly string[]).includes(scope)) {
        return {
          ok: false,
          error: vscode.l10n.t(
            'The setting "{0}" was not written: it takes one of {1}.',
            key,
            AI_PRE_REVIEW_PROMPT_SCOPES.join(', '),
          ),
        };
      }
      await writeSettingValue('aiPreReviewPromptScope', scope as AiPreReviewPromptScopeValue);
      logger.info(`The settings page wrote "${key}" = "${scope}"`);
      return { ok: true };
    }
    if (key === 'forgejoToolkit.prDescriptionPromptScope') {
      const scope = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!(PR_DESCRIPTION_PROMPT_SCOPES as readonly string[]).includes(scope)) {
        return {
          ok: false,
          error: vscode.l10n.t(
            'The setting "{0}" was not written: it takes one of {1}.',
            key,
            PR_DESCRIPTION_PROMPT_SCOPES.join(', '),
          ),
        };
      }
      await writeSettingValue('prDescriptionPromptScope', scope as PrDescriptionPromptScopeValue);
      logger.info(`The settings page wrote "${key}" = "${scope}"`);
      return { ok: true };
    }
    if (key === 'forgejoToolkit.issueTriagePromptScope') {
      const scope = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!(ISSUE_TRIAGE_PROMPT_SCOPES as readonly string[]).includes(scope)) {
        return {
          ok: false,
          error: vscode.l10n.t(
            'The setting "{0}" was not written: it takes one of {1}.',
            key,
            ISSUE_TRIAGE_PROMPT_SCOPES.join(', '),
          ),
        };
      }
      await writeSettingValue('issueTriagePromptScope', scope as IssueTriagePromptScopeValue);
      logger.info(`The settings page wrote "${key}" = "${scope}"`);
      return { ok: true };
    }
    if (key === 'forgejoToolkit.notificationPollingInterval') {
      // The manifest's own range, refused rather than clamped: VS Code's settings
      // editor refuses a value outside `minimum`/`maximum` too, and clamping would
      // store a number the user never typed. A value that got into the store by
      // hand is still survivable — the poller's reader clamps it (§3.5).
      const seconds = rawValue;
      if (
        typeof seconds !== 'number' ||
        !Number.isFinite(seconds) ||
        seconds < NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS ||
        seconds > NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS
      ) {
        return {
          ok: false,
          error: vscode.l10n.t(
            'The setting "{0}" was not written: it takes a number of seconds between {1} and {2}.',
            key,
            NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS,
            NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS,
          ),
        };
      }
      await writeSettingValue('notificationPollingInterval', seconds);
      logger.info(`The settings page wrote "${key}" = ${seconds}`);
      return { ok: true };
    }
    if (typeof rawValue !== 'boolean') {
      return {
        ok: false,
        error: vscode.l10n.t('The setting "{0}" was not written: it takes on or off.', key),
      };
    }
    if (WRITE_TOOL_BY_SETTING[key] !== undefined) {
      await writeMcpWriteTool(key, rawValue);
    } else {
      await writeSettingValue(key.slice(`${SETTINGS_SECTION}.`.length), rawValue);
    }
    logger.info(`The settings page wrote "${key}" = ${rawValue}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: vscode.l10n.t(
        'The setting "{0}" was not written: {1}',
        key,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}
