import * as vscode from 'vscode';
import { logger } from '../logger';
import { userFacingErrorMessage } from '../api/errors';
import { aiProviderSettingsReading } from '../ai/modelSettings';
import { aiProviderTestAddress, aiTestProviderCommand } from '../ai/testProvider';
import { findAiPreReviewPanel } from '../aiPreReviewPanelRegistry';
import type { AiPreReviewPanel } from '../aiPreReviewPanel';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';

/**
 * The contributed `webview/context` items, and the one place their argument is read.
 *
 * A `webview/context` item runs **in the extension host**, so the row under the cursor
 * reaches it only through VS Code: the element's `data-vscode-context` object becomes
 * the menu's context keys *and* the command's first argument (see
 * `docs/architecture/README.md` and the Webview API's "Context menus" section). That
 * makes this argument webview input of the same rank as any message, and a webview is
 * untrusted everywhere in this repository — so {@link readRowTarget} re-validates
 * every field before a command navigates, copies or opens anything, and a row that
 * names something unsafe is a no-op with a log line rather than a side effect.
 *
 * The section names are mirrored from `webview/src/utils/contextMenu.ts` (the webview
 * half that writes the markers) and the same strings appear in the manifest's `when`
 * clauses; `src/__tests__/webviewContextMenu.test.ts` holds all three spellings
 * together so they cannot drift apart.
 */

/** The view id every clause and this handler pin the sidebar to. */
export const WEBVIEW_CONTEXT_MENU_VIEW_ID = 'forgejoToolkitView';

/** The AI pre-review panel's view id (an editor-area panel, one per run). */
export const WEBVIEW_CONTEXT_MENU_PRE_REVIEW_VIEW_ID = 'forgejoToolkitAiPreReview';

/** The settings page's view id (an editor-area panel, not the sidebar). */
export const WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID = 'forgejoToolkitSettings';

/** The row families the markers publish. */
export const WEBVIEW_CONTEXT_MENU_SECTIONS = [
  'repositoryRow',
  'pullRequestRow',
  'issueRow',
  'notificationRow',
  'settingsInstanceRow',
  'settingsEndpointRow',
  'preReviewSuggestion',
  'runLog',
] as const;

/** One value of {@link WEBVIEW_CONTEXT_MENU_SECTIONS}. */
export type WebviewContextMenuSection = (typeof WEBVIEW_CONTEXT_MENU_SECTIONS)[number];

/**
 * Which webview each section belongs to.
 *
 * It is what makes the `webview` field VS Code adds part of the validation rather than a
 * formality: a marker that publishes the settings sections cannot be driven from the
 * sidebar (or the other way round), so a forged argument cannot turn an item from one
 * surface into an action on another.
 */
export const WEBVIEW_CONTEXT_MENU_SECTION_VIEWS: Record<WebviewContextMenuSection, string> = {
  repositoryRow: WEBVIEW_CONTEXT_MENU_VIEW_ID,
  pullRequestRow: WEBVIEW_CONTEXT_MENU_VIEW_ID,
  issueRow: WEBVIEW_CONTEXT_MENU_VIEW_ID,
  notificationRow: WEBVIEW_CONTEXT_MENU_VIEW_ID,
  settingsInstanceRow: WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID,
  settingsEndpointRow: WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID,
  preReviewSuggestion: WEBVIEW_CONTEXT_MENU_PRE_REVIEW_VIEW_ID,
  runLog: WEBVIEW_CONTEXT_MENU_VIEW_ID,
};

/** The command ids contributed under `webview/context`. */
export const WEBVIEW_CONTEXT_MENU_COMMANDS = {
  openRepositoryRow: 'forgejoToolkit.openRepositoryRow',
  copyRepositoryAddress: 'forgejoToolkit.copyRepositoryAddress',
  openIssueRow: 'forgejoToolkit.openIssueRow',
  openPullRequestRow: 'forgejoToolkit.openPullRequestRow',
  copyRowReference: 'forgejoToolkit.copyRowReference',
  openRowInBrowser: 'forgejoToolkit.openRowInBrowser',
  markNotificationRowRead: 'forgejoToolkit.markNotificationRowRead',
  editInstanceRow: 'forgejoToolkit.editInstanceRow',
  removeInstanceRow: 'forgejoToolkit.removeInstanceRow',
  copyInstanceAddress: 'forgejoToolkit.copyInstanceAddress',
  testProviderRow: 'forgejoToolkit.testProviderRow',
  editProviderRow: 'forgejoToolkit.editProviderRow',
  copyProviderAddress: 'forgejoToolkit.copyProviderAddress',
  copyPreReviewSuggestion: 'forgejoToolkit.copyPreReviewSuggestion',
  openPreReviewSuggestionDiff: 'forgejoToolkit.openPreReviewSuggestionDiff',
  copyRunLogSelection: 'forgejoToolkit.copyRunLogSelection',
} as const;

/** One row's identity, after validation. */
export interface RowTarget {
  section: WebviewContextMenuSection;
  /** The configured instance a sidebar row or a settings instance row names. */
  instanceId?: string;
  owner?: string;
  repo?: string;
  index?: number;
  notificationId?: number;
  /** The configured AI endpoint a settings row names. */
  providerId?: string;
  /** The AI pre-review panel a suggestion card belongs to. */
  panelId?: string;
  /** The suggestion card's index, inside that panel's own payload. */
  suggestionIndex?: number;
  /** The selected job-log text the marker carried, for the Copy item. */
  logText?: string;
}

/** A segment of a repository path: `owner` and `repo` are never empty and never a path. */
function safeSegment(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > 255) {
    return undefined;
  }
  // The values end up inside a URL and a copied reference; a separator, a traversal
  // step or a control character is not a name any instance can have, and refusing
  // them keeps a forged marker from re-pointing the command at another repository.
  if (value === '.' || value === '..') {
    return undefined;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || '/\\?#'.includes(character)) {
      return undefined;
    }
  }
  return value;
}

/** A positive integer field (an issue/PR number, a notification id). */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A non-negative integer field (a card index: the payload's own identity starts at 0). */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The row one context-menu argument names, or `undefined` when it names one this
 * extension must not act on.
 *
 * Every rejection is deliberate: a missing or foreign `webview`, a `webviewSection`
 * this build does not contribute, a missing identity, an unsafe `owner`/`repo` and a
 * non-integer index all mean the menu item is acting on something it was not shown.
 */
export function readRowTarget(value: unknown): RowTarget | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const argument = value as Record<string, unknown>;
  const section = WEBVIEW_CONTEXT_MENU_SECTIONS.find((candidate) => candidate === argument.webviewSection);
  if (section === undefined) {
    return undefined;
  }
  // VS Code adds `webview` from the webview's own view type; requiring it to be the
  // view **this section belongs to** means a forged argument cannot move an item from
  // one surface onto another.
  if (argument.webview !== WEBVIEW_CONTEXT_MENU_SECTION_VIEWS[section]) {
    return undefined;
  }
  const instanceId = typeof argument.forgejoInstanceId === 'string' ? argument.forgejoInstanceId : '';
  const owner = safeSegment(argument.forgejoOwner);
  const repo = safeSegment(argument.forgejoRepo);
  const index = positiveInteger(argument.forgejoIndex);
  const notificationId = positiveInteger(argument.forgejoNotificationId);
  switch (section) {
    case 'repositoryRow':
      // A repository row names a repository and nothing else.
      return instanceId !== '' && owner !== undefined && repo !== undefined
        ? { section, instanceId, owner, repo }
        : undefined;
    case 'issueRow':
    case 'pullRequestRow':
      return instanceId !== '' && owner !== undefined && repo !== undefined && index !== undefined
        ? { section, instanceId, owner, repo, index }
        : undefined;
    case 'notificationRow':
      // A notification row always carries its own id; the open items need the
      // coordinates, and their `when` clauses only match a row that has them.
      return instanceId !== '' && notificationId !== undefined
        ? {
            section,
            instanceId,
            notificationId,
            ...(owner !== undefined && repo !== undefined && index !== undefined ? { owner, repo, index } : {}),
          }
        : undefined;
    case 'settingsInstanceRow':
      // The settings rows name a configured entity by id, and nothing else: the page
      // looks that id up in the snapshot it is rendering.
      return instanceId !== '' ? { section, instanceId } : undefined;
    case 'settingsEndpointRow': {
      const providerId = safeSegment(argument.forgejoProviderId);
      return providerId !== undefined ? { section, providerId } : undefined;
    }
    case 'preReviewSuggestion': {
      // A card names its panel and its own card index — the index is 0-based (it is the
      // card's identity in the panel's payload), so it is a non-negative integer.
      const panelId = safeSegment(argument.forgejoPanelId);
      const suggestionIndex = nonNegativeInteger(argument.forgejoSuggestionIndex);
      return panelId !== undefined && suggestionIndex !== undefined ? { section, panelId, suggestionIndex } : undefined;
    }
    case 'runLog': {
      // The log's marker exists only while a non-empty selection does, and it says so;
      // the text it carries is what the Copy item puts on the clipboard.
      //
      // Two deliberate properties, recorded because they are *intent*, not accidents:
      //
      // 1. The clause and this validation are about **the fact the marker carries**, not
      //    about a live selection — the host cannot see the webview's selection. A stale
      //    marker is therefore one somebody planted by hand (the real one is removed on
      //    `selectionchange`), and the most such a marker can do is copy exactly the text
      //    it carries, never another element's text. Both fields are re-validated for
      //    that reason, and a refusal says so rather than doing nothing (see
      //    `warnAboutRefusedLogMarker`).
      // 2. The webview publishes nothing over the bound, so it never copies a partial
      //    selection; this bound only refuses a marker that claims more. **The menu path
      //    cannot reach that refusal any more**: the policy withdraws a log marker whose
      //    carried text is not the live selection before VS Code reads the context keys
      //    (`withdrawStaleLogMarker`), and a marker over the bound never equals the live
      //    selection at click time — so it is withdrawn first and the item is not offered.
      //    This branch is therefore **defence in depth**, kept because a forged argument
      //    must never put invalid text on the clipboard and because a direct command
      //    invocation does not go through the menu at all; the palette hides the command,
      //    so that route is an explicit invocation rather than an accident.
      if (argument.forgejoLogSelection !== true) {
        return undefined;
      }
      const logText = typeof argument.forgejoLogText === 'string' ? argument.forgejoLogText : '';
      if (logText.trim() === '' || logText.length > LOG_TEXT_MAX_CHARS) {
        return undefined;
      }
      return { section, logText };
    }
  }
}

/**
 * The most the log marker may carry, mirrored from
 * `CONTEXT_MENU_LOG_SELECTION_MAX_CHARS` in `webview/src/utils/contextMenu.ts`.
 *
 * The webview publishes a marker only while the whole selection fits under this bound
 * (over it, the item is not offered at all); this is the host's own refusal of a marker
 * that claims more, so a forged attribute cannot ask the clipboard for an unbounded
 * string.
 */
const LOG_TEXT_MAX_CHARS = 1_000_000;

/**
 * One URL path segment, percent-encoded.
 *
 * `safeSegment` already refuses a separator, a traversal step and a control character,
 * but it deliberately accepts a `%`: a name may legitimately contain one, and the
 * validator's job is only to refuse what no name can be. The encoding is what makes the
 * **built** address safe — a forged `..%2f..%2fadmin` leaves here as
 * `..%252f..%252fadmin`, which no server can read as a separator, and a real name with a
 * `%` survives intact.
 */
function urlSegment(value: string): string {
  return encodeURIComponent(value);
}

/** The browser path one row's entity lives at, for the "open in browser" item. */
function browserPath(target: RowTarget): string | undefined {
  if (
    target.instanceId === undefined ||
    target.owner === undefined ||
    target.repo === undefined ||
    target.index === undefined
  ) {
    return undefined;
  }
  const prefix = target.section === 'pullRequestRow' ? 'pulls' : 'issues';
  return `${urlSegment(target.owner)}/${urlSegment(target.repo)}/${prefix}/${target.index}`;
}

/**
 * Whether a refused argument **claimed** to be the job log's.
 *
 * The claim is read from the raw argument, before validation, because that is exactly the
 * case this exists for: a marker this build would not have published still names a
 * section, and when that section is the log the reader pressed Copy and deserves a
 * sentence instead of a click that appears to have worked.
 */
function claimedLogSection(argument: unknown): boolean {
  return (
    typeof argument === 'object' &&
    argument !== null &&
    (argument as { webviewSection?: unknown }).webviewSection === 'runLog'
  );
}

/**
 * The sentence a refused log marker gets.
 *
 * Both shapes it covers are unreachable from this extension's own webview — a blank
 * selection and one over the bound publish **no marker at all**, so the item is not even
 * offered — which leaves a hand-planted or stale attribute. Saying so is still the
 * repository's rule: a refusal is stated rather than silently no-op.
 */
const REFUSED_LOG_SELECTION_MESSAGE = vscode.l10n.t(
  'That log selection could not be copied. Select the text you want and press Copy again.',
);

/**
 * Registers the contributed items' handlers.
 *
 * Every action reuses what already exists: the navigation messages are the same ones
 * the sidebar's own clicks use (the three `reveal*` methods), the notification read is
 * the provider's own notification path, and the copy/browser items are `vscode.env`
 * calls. Nothing here writes to the server except marking one notification read, which
 * is the item's whole purpose.
 */
export function registerWebviewContextMenuCommands(
  viewProvider: ForgejoToolkitViewProvider,
  secrets: vscode.SecretStorage,
): vscode.Disposable[] {
  const withTarget = (command: string, run: (target: RowTarget) => void | Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(command, (argument?: unknown) => {
      const target = readRowTarget(argument);
      if (target === undefined) {
        logger.debug(`${command}: refused a context-menu argument this view did not publish`);
        // A refused argument normally means a marker this build did not publish (a stale
        // tab, a hand-planted attribute). The log arm is the one where silence would look
        // like a Copy that worked, so it says what happened; every other arm's item is a
        // no-op the reader can see is a no-op.
        if (claimedLogSection(argument)) {
          void vscode.window.showWarningMessage(REFUSED_LOG_SELECTION_MESSAGE);
        }
        return;
      }
      try {
        const result = run(target);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            logger.error(`${command} failed: ${userFacingErrorMessage(error)}`);
          });
        }
      } catch (error) {
        logger.error(`${command} failed: ${userFacingErrorMessage(error)}`);
      }
    });

  return [
    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openRepositoryRow, (target) => {
      if (target.instanceId !== undefined && target.owner !== undefined && target.repo !== undefined) {
        viewProvider.revealRepositoryDetail({
          instanceId: target.instanceId,
          owner: target.owner,
          repo: target.repo,
        });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRepositoryAddress, async (target) => {
      if (target.instanceId === undefined || target.owner === undefined || target.repo === undefined) {
        return;
      }
      const base = viewProvider.instanceBaseUrl(target.instanceId);
      if (base === undefined) {
        logger.debug('copyRepositoryAddress: the row names an instance this window no longer has');
        return;
      }
      await vscode.env.clipboard.writeText(`${base}/${urlSegment(target.owner)}/${urlSegment(target.repo)}.git`);
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openIssueRow, (target) => {
      if (
        target.instanceId !== undefined &&
        target.owner !== undefined &&
        target.repo !== undefined &&
        target.index !== undefined
      ) {
        viewProvider.revealIssueDetail({
          instanceId: target.instanceId,
          owner: target.owner,
          repo: target.repo,
          index: target.index,
        });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow, (target) => {
      if (
        target.instanceId !== undefined &&
        target.owner !== undefined &&
        target.repo !== undefined &&
        target.index !== undefined
      ) {
        // The same message the pre-review panel's "open the pull request" uses.
        viewProvider.revealPullRequestDetail({
          instanceId: target.instanceId,
          owner: target.owner,
          repo: target.repo,
          index: target.index,
        });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRowReference, async (target) => {
      if (
        target.instanceId === undefined ||
        target.owner === undefined ||
        target.repo === undefined ||
        target.index === undefined
      ) {
        return;
      }
      // The reference format the row's own copy button already produces.
      await vscode.env.clipboard.writeText(`${target.owner}/${target.repo}#${target.index}`);
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser, async (target) => {
      const path = browserPath(target);
      if (path === undefined || target.instanceId === undefined) {
        return;
      }
      const base = viewProvider.instanceBaseUrl(target.instanceId);
      if (base === undefined) {
        logger.debug('openRowInBrowser: the row names an instance this window no longer has');
        return;
      }
      // Built here from the instance's own address rather than taken from the marker:
      // the webview never gets to name the URL the editor opens.
      await vscode.env.openExternal(vscode.Uri.parse(`${base}/${path}`));
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.markNotificationRowRead, async (target) => {
      if (target.instanceId === undefined || target.notificationId === undefined) {
        return;
      }
      const marked = await viewProvider.markNotificationRead(target.instanceId, target.notificationId);
      if (!marked) {
        logger.debug('markNotificationRowRead: the row names an instance this window no longer has');
      }
    }),

    // The settings page's two rows. "Edit" is the host asking the page to open the
    // editor it owns (the page looks the id up in its own snapshot); "Remove" and the
    // two copy items are the host's own work.
    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.editInstanceRow, (target) => {
      if (target.instanceId !== undefined) {
        viewProvider.openSettingsEditorFor({ command: 'settingsEditInstance', id: target.instanceId });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.removeInstanceRow, async (target) => {
      if (target.instanceId !== undefined) {
        // The provider's own path, so the destructive confirmation is the host's and
        // there is exactly one of it.
        await viewProvider.removeInstanceById(target.instanceId);
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyInstanceAddress, async (target) => {
      if (target.instanceId === undefined) {
        return;
      }
      // The functional URL, credential material stripped: what a reader pastes into a
      // browser or git, not the display value the settings row renders.
      const base = viewProvider.instanceBaseUrl(target.instanceId);
      if (base === undefined) {
        logger.debug('copyInstanceAddress: the row names an instance this window no longer has');
        return;
      }
      await vscode.env.clipboard.writeText(base);
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.testProviderRow, async (target) => {
      if (target.providerId !== undefined) {
        // The same runner the settings page's own Test button uses, with the id this
        // item carries: one probe implementation, one report.
        await aiTestProviderCommand(secrets, target.providerId);
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.editProviderRow, (target) => {
      if (target.providerId !== undefined) {
        viewProvider.openSettingsEditorFor({ command: 'settingsEditProvider', id: target.providerId });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyProviderAddress, async (target) => {
      if (target.providerId === undefined) {
        return;
      }
      // Read from the host's own reading of the endpoints, not from the marker: the
      // address is the same display form the settings row shows (no query, no userinfo).
      const provider = aiProviderSettingsReading().providers.find((candidate) => candidate.id === target.providerId);
      if (provider === undefined) {
        logger.debug('copyProviderAddress: the row names an endpoint this window no longer has');
        return;
      }
      await vscode.env.clipboard.writeText(aiProviderTestAddress(provider));
    }),

    // The pre-review panel's suggestion cards. Both items resolve **the panel the card
    // came from** through the registry, and both take their content from that panel's own
    // payload — the marker carries an index and a panel id, never a body or an anchor.
    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyPreReviewSuggestion, async (target) => {
      const panel = resolveSuggestionPanel(target);
      if (panel === undefined) {
        return;
      }
      if (!(await panel.copySuggestionBody(target.suggestionIndex))) {
        // The panel is open but no longer offers that card (a payload replaced under it):
        // say so rather than leaving the click looking like it worked.
        void vscode.window.showWarningMessage(SUGGESTION_GONE_MESSAGE);
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openPreReviewSuggestionDiff, async (target) => {
      const panel = resolveSuggestionPanel(target);
      if (panel === undefined) {
        return;
      }
      await panel.openSuggestionDiff(target.suggestionIndex);
    }),

    // The job log's Copy item. The text is the selection the marker published and the
    // host re-validated (non-empty, bounded) — the item exists only while a selection
    // does, so it can never be pressed with nothing to copy.
    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRunLogSelection, async (target) => {
      if (target.logText !== undefined) {
        await vscode.env.clipboard.writeText(target.logText);
      }
    }),
  ];
}

/**
 * The refusal sentence for a panel that is no longer open.
 *
 * A stale id is a real case — the reader right-clicks a card, the panel is closed before
 * the item runs, or a marker outlives its panel — and the honest answer is a sentence
 * rather than a click that appears to do nothing. The id is still validated by the
 * registry, never trusted: an id nothing is registered under simply has no panel.
 */
const SUGGESTION_GONE_MESSAGE = vscode.l10n.t(
  'That AI pre-review panel is no longer open, so nothing was done. Open a pre-review and try again from its own card.',
);

/**
 * The panel a suggestion-card item names, with the refusal sentence already shown when
 * there is none.
 */
function resolveSuggestionPanel(target: RowTarget): AiPreReviewPanel | undefined {
  if (target.panelId === undefined) {
    return undefined;
  }
  const panel = findAiPreReviewPanel(target.panelId);
  if (panel === undefined) {
    void vscode.window.showWarningMessage(SUGGESTION_GONE_MESSAGE);
    return undefined;
  }
  return panel;
}
