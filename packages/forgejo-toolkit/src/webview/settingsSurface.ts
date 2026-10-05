import * as vscode from 'vscode';
import {
  AI_PRE_REVIEW_PROMPT_SCOPES,
  PR_DESCRIPTION_PROMPT_SCOPES,
  SETTINGS_SURFACE_WRITABLE_KEYS,
  type AiPreReviewPromptScopeValue,
  type PrDescriptionPromptScopeValue,
  type SettingsSurfaceSnapshot,
  type SettingsSurfaceWritableKey,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { aiPreReviewPromptScopeSettingValue, isAiPreReviewEnabled } from '../aiPreReviewSettings';
import { isPrDescriptionEnabled, prDescriptionPromptScopeSettingValue } from '../prDescriptionSettings';
import { enabledMcpWriteTools, isMcpWriteAuditToFileEnabled, MCP_WRITE_TOOLS_KEY } from '../mcpWriteSettings';
import { isMcpServerEnabled } from '../mcpServerProvider';
import { isMultiWindowLeaseEnabled } from '../lease/leaseSupervisor';
import { MCP_WRITE_TOOL_SETTING_KEYS, type McpWriteTool } from '../../mcp/writeTools';
import { logger } from '../logger';

/**
 * The settings page's own surface: which settings it renders, which it leaves to
 * VS Code's own settings editor, and how the nine it renders are read and written
 * (`docs/design/settings-page.md` §1.3, §3.2, §6).
 *
 * The module exists for the reason the record gives for the policy half of it:
 * **the page's ownership policy has one home**. `NATIVE_ONLY_SETTINGS` is that
 * home — the settings that stay native together with the reason each one does —
 * and `src/__tests__/settingsSurface.test.ts` holds it against the manifest and
 * the webview's English string catalogue, which together are the other half of
 * the same fact ("rendered" vs "native-only"). The page's own text, this module
 * and the test all refer to this list rather than restating it.
 *
 * The reads reuse the **feature readers** the behaviours themselves use
 * (`isMcpServerEnabled`, `enabledMcpWriteTools`, `isMcpWriteAuditToFileEnabled`,
 * `isMultiWindowLeaseEnabled`, `isAiPreReviewEnabled`,
 * `aiPreReviewPromptScopeSettingValue`), so the page cannot claim a switch is on
 * while the feature reads it off. The one exception is the notification poller,
 * whose reader lives on `ConfigManager` (it owns that switch); it is passed in as
 * a dependency for the same reason: one reading, not two.
 *
 * Writes go to **global** scope, matching every other control this page has
 * (`setLocale`, `setDebug`, `setWorktreeOpenMode`, the AI model policy): the page
 * edits the user's own settings, and a workspace-level override stays what it is
 * — which is why every write is followed by a fresh read and the reply carries
 * the value that is actually in effect.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * One setting the page deliberately does **not** render, with the reason it stays
 * in VS Code's own settings editor.
 *
 * The reason is read by the drift guard's failure message and by whoever adds the
 * next setting, so it is written for a maintainer rather than for a user: the
 * user-facing pointer a native-only setting gets on the page is an i18n string of
 * its own (§2.2), not this sentence. English on purpose, like the rest of the
 * test-facing surface (`docs/design/settings-page.md` §8 question 6).
 */
export interface NativeOnlySetting {
  /** The full setting id, exactly as the manifest contributes it. */
  key: string;
  reason: string;
}

/**
 * The settings that stay native, and why (§1.3).
 *
 * Three, and each is a decision rather than an omission: `notificationPollingInterval`
 * and `aiTransport` are ordinary typed settings VS Code's own editor renders
 * better than this page can (a range, an enum) — the page only names them, with a
 * pointer row — and `useMockApi` is a development switch that must not look like
 * a feature. `useMockApi` gets no pointer at all (§2.2): mentioning it is what
 * would make a user think it is one.
 */
export const NATIVE_ONLY_SETTINGS: readonly NativeOnlySetting[] = [
  {
    key: 'forgejoToolkit.notificationPollingInterval',
    reason:
      "A plain number with a minimum and a maximum (60–3600 seconds). VS Code's own editor renders that " +
      'range; a field here would be a second place to validate it, and the notification section names the ' +
      'setting with a pointer row instead.',
  },
  {
    key: 'forgejoToolkit.aiTransport',
    reason:
      'A three-value enum VS Code renders completely. Rendering it here would mean a second place to handle ' +
      '"the host refused the value and the control has to bounce back"; the endpoint section names the ' +
      'setting with a pointer row instead.',
  },
  {
    key: 'forgejoToolkit.useMockApi',
    reason:
      'A development switch, and its own description says so ("Development use only; stripped from production ' +
      'builds"). Putting it on a user-facing page would read as a feature. It is deliberately not mentioned ' +
      'anywhere on the page either.',
  },
];

/** What one host-side read of the surface needs from its caller. */
export interface SettingsSurfaceReadDeps {
  /**
   * `ConfigManager.isNotificationPollingEnabled`: the same reading the poller
   * itself obeys, so the switch on the page cannot disagree with the behaviour.
   */
  isNotificationPollingEnabled: () => boolean;
}

/** Whether a value is one of the nine keys the page may write. */
export function isSettingsSurfaceWritableKey(value: unknown): value is SettingsSurfaceWritableKey {
  return typeof value === 'string' && (SETTINGS_SURFACE_WRITABLE_KEYS as readonly string[]).includes(value);
}

/** Reads the settings the page's own sections present. */
export function readSettingsSurface(deps: SettingsSurfaceReadDeps): SettingsSurfaceSnapshot {
  const enabledWriteTools = enabledMcpWriteTools();
  return {
    notificationPollingEnabled: deps.isNotificationPollingEnabled(),
    mcpEnabled: isMcpServerEnabled(),
    mcpWriteTools: {
      createIssueComment: enabledWriteTools.includes('create_issue_comment'),
      submitPullReview: enabledWriteTools.includes('submit_pull_review'),
      cancelActionRun: enabledWriteTools.includes('cancel_action_run'),
    },
    mcpWriteAuditToFile: isMcpWriteAuditToFileEnabled(),
    multiWindowLease: isMultiWindowLeaseEnabled(),
    aiPreReview: isAiPreReviewEnabled(),
    aiPreReviewPromptScope: aiPreReviewPromptScopeSettingValue(),
    prDescription: isPrDescriptionEnabled(),
    prDescriptionPromptScope: prDescriptionPromptScopeSettingValue(),
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
 * one of the nine, and the value has to be the type that key takes. A value that
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
