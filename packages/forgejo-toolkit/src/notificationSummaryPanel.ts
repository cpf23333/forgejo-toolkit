import * as vscode from 'vscode';
import { logger } from './logger';
import { userFacingErrorMessage } from './api/errors';
import { resolveLocale } from './utils/resolveLocale';
import { getWebviewContent } from './webview/content';
import type {
  HostToWebviewMessage,
  NotificationSummaryPanelPayload,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The notification summary, as an editor-tab panel.
 *
 * It is the presentation surface for prose that would be unreadable in a notification
 * row: the sidebar is a column a few hundred pixels wide, and what this feature produces
 * is a paragraph someone wants to read, copy and keep open while they decide what to do
 * about the notification (`docs/design/notification-summary.md` §4.1). The panel's own
 * layout and wording live in the webview half; this class owns the tab.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **One panel, re-rendered — never stacked.** The tab is a singleton here: a second
 *    run for another notification replaces the payload of the panel already open (and
 *    reveals it) rather than opening a second tab, so there is exactly one summary on
 *    screen and nothing accumulates when a reader walks down a list of notifications
 *    (§4).
 * 2. **The first paint needs no round trip.** The payload travels in the document's own
 *    `__FORGEJO_TOOLKIT_CONFIG__` (the pre-review panel's pattern), and
 *    `notificationSummaryPanelPayload` is what a later payload — a regenerate, or another
 *    notification — arrives as.
 * 3. **The panel writes nothing.** Its two messages are "run this again once" and "open
 *    the settings"; the run is host-side and read-only, and no answer of this feature
 *    reaches the server at all (§8).
 *
 * The panel's regenerate is the run itself, handed in by the caller: this class never
 * knows what a summary is, only that a payload arrived and that one more may be asked
 * for. A run that throws is reported to the log and turned into a `refused` payload,
 * because the webview spends its single regenerate on the click and would otherwise wait
 * for an answer that never comes.
 */
export class NotificationSummaryPanel implements vscode.Disposable {
  public static readonly viewType = 'forgejoToolkitNotificationSummary';

  /** The panel on screen, if any: the tab is reused rather than stacked. */
  private static _current: NotificationSummaryPanel | undefined;

  /**
   * Opens the panel, or re-renders the one already open for this payload.
   *
   * `run` is what the panel's single regenerate calls, and it is replaced on every call:
   * the callback closes over the notification the current payload is about, and a panel
   * re-rendered for another notification must regenerate *that* one.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    payload: NotificationSummaryPanelPayload,
    run?: NotificationSummaryRunner,
  ): NotificationSummaryPanel {
    const existing = NotificationSummaryPanel._current;
    if (existing) {
      existing._show(payload, run);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      NotificationSummaryPanel.viewType,
      panelTitle(payload),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
        // The reader keeps the prose while they look at the issue in another tab;
        // without this, switching editors would empty the page and force a re-run
        // (the pre-review panel keeps its checkboxes for the same reason).
        retainContextWhenHidden: true,
      },
    );
    return new NotificationSummaryPanel(panel, extensionUri, payload, run);
  }

  /** The panel on screen, if any. Exported so a test can pin the single-instance rule. */
  public static get current(): NotificationSummaryPanel | undefined {
    return NotificationSummaryPanel._current;
  }

  private readonly _disposables: vscode.Disposable[] = [];
  private _disposed = false;
  /** Whether a regenerate is in flight, so two clicks cannot start two runs. */
  private _regenerating = false;

  private constructor(
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    payload: NotificationSummaryPanelPayload,
    private _run?: NotificationSummaryRunner,
  ) {
    NotificationSummaryPanel._current = this;
    this._payload = payload;
    this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((message) => void this._handleMessage(message), null, this._disposables);
  }

  private _payload: NotificationSummaryPanelPayload;

  /** Replaces the payload and shows the tab, without rebuilding the document. */
  private _show(payload: NotificationSummaryPanelPayload, run?: NotificationSummaryRunner): void {
    this._payload = payload;
    this._run = run;
    this._panel.title = panelTitle(payload);
    // The webview assigns the payload wholesale; there is no field list here for a
    // field to fall out of, which is the lesson `useAppState`'s import preview paid
    // for.
    this._post({ command: 'notificationSummaryPanelPayload', payload });
    this._panel.reveal();
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    if (NotificationSummaryPanel._current === this) {
      NotificationSummaryPanel._current = undefined;
    }
    while (this._disposables.length > 0) {
      this._disposables.pop()?.dispose();
    }
    // `dispose()` on the panel is what VS Code called us for when the user closed the
    // tab; calling it here for the host's own disposal is idempotent.
    this._panel.dispose();
  }

  private async _handleMessage(message: unknown): Promise<void> {
    const command =
      message && typeof message === 'object' && typeof (message as { command?: unknown }).command === 'string'
        ? (message as { command: string }).command
        : undefined;
    logger.debug(`Received message from the notification-summary panel: ${String(command)}`);
    switch (command) {
      case 'notificationSummaryRegenerate':
        await this._regenerate();
        return;
      case 'openNativeSettings':
        // The one settings destination a webview can reach, and the same action the
        // settings page's own "no usable model" block uses (`ai-model-transport.md`
        // §8.7). It writes nothing and reveals the page.
        await vscode.commands.executeCommand('forgejoToolkit.openNativeSettings');
        return;
      default:
        return;
    }
  }

  /**
   * Runs the summary once more for the entity this panel is showing.
   *
   * The consent gate, the reads and the model call all happen again — a panel is not a
   * cache, and a run whose scope is still `ask` asks again. A run that throws is turned
   * into a `refused` payload rather than leaving the page waiting: the webview spends its
   * single regenerate on the click.
   */
  private async _regenerate(): Promise<void> {
    if (this._disposed || this._regenerating) {
      return;
    }
    const run = this._run;
    if (!run) {
      logger.debug('Notification summary panel: no run is registered, so the regenerate was dropped');
      return;
    }
    const { instanceId, owner, repo, index, type } = this._payload;
    this._regenerating = true;
    try {
      const next = await run({ instanceId, owner, repo, index, type });
      if (this._disposed) {
        return;
      }
      this._show(next, run);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Notification summary panel: the regenerate run failed: ${err}`);
      if (this._disposed) {
        return;
      }
      this._show(
        {
          instanceId,
          owner,
          repo,
          type,
          index,
          outcome: 'refused',
          failure: vscode.l10n.t('The summary could not be produced: {0}. Nothing was written.', err),
        },
        run,
      );
    } finally {
      this._regenerating = false;
    }
  }

  /**
   * Renders the panel's document.
   *
   * The payload travels in `__FORGEJO_TOOLKIT_CONFIG__` exactly like the pre-review
   * panel's, so the first paint shows the answer without a round trip.
   * `notificationSummaryPanelPayload` is what a payload that replaces it arrives as.
   */
  private _update(): void {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'notificationSummary',
      locale,
      notificationSummary: this._payload,
    });
  }

  private _post(message: HostToWebviewMessage): void {
    if (this._disposed) {
      return;
    }
    // The reply is dropped rather than awaited: nobody can consume it any more, and an
    // unhandled rejection out of a disposed webview would surface in the extension host
    // (the other panels guard the same hazard).
    void Promise.resolve(this._panel.webview.postMessage(message)).catch(() => undefined);
  }
}

/** The function one regenerate runs: one more summary for one entity. */
export type NotificationSummaryRunner = (target: {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  type: 'issue' | 'pull';
}) => Promise<NotificationSummaryPanelPayload>;

/**
 * The tab's title: the entity, so two open notifications are told apart in the tab bar.
 *
 * The payload carries the title once the record was read and nothing before that, which
 * is why the entity is what the tab is named for.
 */
function panelTitle(payload: NotificationSummaryPanelPayload): string {
  return vscode.l10n.t('Discussion summary: {0}/{1}#{2}', payload.owner, payload.repo, payload.index);
}
