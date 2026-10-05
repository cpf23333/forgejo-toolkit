import * as vscode from 'vscode';
import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import { resolveLocale } from '../utils/resolveLocale';
import { logger } from '../logger';

/**
 * The webview surface one handler's replies go to.
 *
 * It exists because the settings tab and the sidebar dashboard are two webviews
 * served by one message dispatcher (`ForgejoToolkitViewProvider._handleMessage`):
 * the handler answers whichever surface asked, and without a channel the reply
 * would always be posted into the sidebar. Passing the channel in is what keeps
 * the dispatcher itself surface-agnostic.
 */
export type WebviewReplySink = (message: HostToWebviewMessage) => void;

/**
 * What the settings tab needs from the extension host that owns its messages.
 *
 * The panel owns the document and the tab's lifecycle; every message it carries
 * is the view provider's own handler, unchanged — the settings page sends exactly
 * the messages the sidebar version sent, and a second switch statement here would
 * be a second implementation of them.
 */
export interface SettingsPanelHost {
  /** Handles one message from the tab, replying to **that** surface. */
  dispatchSettingsMessage(message: unknown, reply: WebviewReplySink): Promise<void>;
  /** The configured instance URLs, whose origins the document's CSP allows. */
  instanceUrls(): string[];
  /** The locale the document is built in, so its first paint is in the right language. */
  locale(): 'en' | 'zh';
}

/**
 * The settings page's home: an editor-area tab (`docs/design/settings-page.md`
 * §9.3).
 *
 * The three lifecycle rules §9.3 writes down, and where each one lives:
 *
 * 1. **One tab per window; opening it again reveals it.** `currentPanel` is the
 *    only instance, and `createOrShow` reveals it instead of stacking a second —
 *    the same shape `OnboardingWebviewPanel` has, and the reason this is a panel
 *    rather than a sidebar view: `reveal` on an existing tab is the behaviour the
 *    command always wanted.
 * 2. **A shown-again tab gets a fresh reading.** `onDidChangeViewState` posts
 *    `refreshSettings` whenever the tab becomes visible, and so does a reveal of
 *    an already-open tab. The page's answer to that message is to re-read
 *    everything it renders through the requests it already has (see
 *    `useAppState`'s `refreshSettings` case), so the host never has to
 *    synthesize a second copy of a snapshot: "the page shows the reading it was
 *    handed" keeps one implementation.
 * 3. **A reopened tab is a new page.** Disposal drops `currentPanel`, so the
 *    next open mints a new document and the page mounts from scratch — nothing is
 *    carried over, including the group the user was last in (§9.4 rule 5).
 */
export class SettingsWebviewPanel {
  public static readonly viewType = 'forgejoToolkitSettings';

  public static currentPanel?: SettingsWebviewPanel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  /**
   * Set by `_dispose`. A handler's reply can settle after the user closed the
   * tab (every AI endpoint read is async), and posting into a disposed panel
   * rejects — the same guard, for the same reason, as the onboarding panel's.
   */
  private _disposed = false;

  public static createOrShow(extensionUri: vscode.Uri, host: SettingsPanelHost): SettingsWebviewPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const existing = SettingsWebviewPanel.currentPanel;
    if (existing) {
      existing._panel.reveal(column);
      // A reveal of an already-visible tab fires no view-state change, and the
      // user asked for the settings page again: answer with a fresh reading
      // rather than with the snapshot the page happened to be holding.
      existing.refresh();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsWebviewPanel.viewType,
      // Host-side l10n, like every other string the host shows: the tab title is
      // the host's, not the webview's (the maintainer's ruling on §9.6 question
      // 7). No icon is set: `WebviewPanel.iconPath` takes an image URI, the
      // extension ships no icon asset, and a codicon (`$(gear)`, which the
      // command and the view-title action draw) is not a form this API accepts.
      vscode.l10n.t('Settings'),
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
        // The tab keeps its page while it is in the background: switching to
        // another tab and back is "shown again", not "reopened", and the fresh
        // reading arrives as `refreshSettings` rather than as a reload.
        retainContextWhenHidden: true,
      },
    );

    SettingsWebviewPanel.currentPanel = new SettingsWebviewPanel(panel, extensionUri, host);
    return SettingsWebviewPanel.currentPanel;
  }

  /**
   * Push a locale change made outside this tab (the language is one of the
   * page's own settings and VS Code's settings editor can change it too). The
   * shared webview composable already handles `setLocale`.
   */
  public static notifyLocaleChanged(locale: 'en' | 'zh'): void {
    SettingsWebviewPanel.currentPanel?._reply({ command: 'setLocale', locale });
  }

  /**
   * A setting this page renders changed **outside** it — a hand edit in VS
   * Code's own settings editor, or an import that wrote several at once.
   *
   * The page reads every such value from the host rather than keeping one of its
   * own, so the answer is the same fresh reading a shown-again tab gets; without
   * it the page would keep showing the value it mounted with, which is the
   * staleness the sidebar version was fixed for.
   */
  public static notifySettingsChanged(): void {
    SettingsWebviewPanel.currentPanel?.refresh();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _host: SettingsPanelHost,
  ) {
    this._panel = panel;
    this._update();

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this.refresh();
        }
      },
      null,
      this._disposables,
    );

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        void this._host.dispatchSettingsMessage(message, (reply) => this._reply(reply));
      },
      undefined,
      this._disposables,
    );
  }

  private _update(): void {
    const instanceUrls = this._host.instanceUrls();
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'settings',
      locale: this._host.locale(),
      instanceUrls,
    });
  }

  /** A fresh reading of everything the page renders (see the class comment). */
  public refresh(): void {
    this._reply({ command: 'refreshSettings' });
  }

  private _reply(message: HostToWebviewMessage): void {
    if (this._disposed) {
      // The webview is gone; posting would reject on a disposed panel.
      return;
    }
    this._panel.webview.postMessage(message);
  }

  private _dispose(): void {
    this._disposed = true;
    SettingsWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

/**
 * The locale the settings document is built in.
 *
 * Exported beside the panel because the host has to answer it in two places —
 * the document it creates and the locale it resolves for that document — and the
 * page's own runtime language follows `setLocale` afterwards either way.
 */
export function settingsLocale(): 'en' | 'zh' {
  try {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    return resolveLocale(configured);
  } catch (error) {
    logger.error(`Could not resolve the locale for the settings tab: ${String(error)}`);
    return 'en';
  }
}
