import * as vscode from 'vscode';
import { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import { OnboardingWebviewPanel } from '../webview/onboardingPanel';
import type { ConfigManager } from '../config';
import type { ReadmeContentProvider } from '../readmeProvider';
import { COMMAND_ADD_COMMENT, PullReviewCommentController } from '../comments/pullReviewCommentController';
import { copyPermalink } from './permalink';
import { copyAgentsWindowMcpConfig } from './agentsWindowMcpConfig';
import { publishToForgejo } from './publish';
import {
  COMMAND_CREATE_ISSUE_FROM_COMMENT,
  createIssueFromComment,
  type CreateIssueFromCommentArgs,
} from '../editor/todoCommentCodeAction';
import { createPrFromCurrentBranch, type CreatePrFromCurrentBranchArgs } from './createPullRequest';
import { registerAiPreReviewCommand } from '../aiPreReview';
import { registerPrDescriptionCommand } from '../prDescription';
import { registerIssueTriage } from '../issueTriage';
import { registerAiTestProviderCommand } from '../ai/testProvider';
import { logger, showErrorWithLog } from '../logger';
import { userFacingErrorMessage } from '../api/errors';
import { REFRESH_VIEW_COMMANDS } from '../webview/activeView';

// Module-level double-click guard for the publish command: the flow mixes
// input boxes, repository creation and git pushes, so a second invocation
// while one is running must not start over. Minimal policy — the late
// trigger is dropped silently (the first run still owns the UI).
let publishToForgejoInFlight = false;

// Same guard for createPrFromCurrentBranch: it is reachable from the status
// bar, and a quick double-click would otherwise stack two copies of the
// input-box flow and push the branch twice. The guard deliberately covers only
// the create flow: an invocation carrying `args.index` is pure navigation to
// an existing pull request (no input boxes, no push), so it must still work
// while a create flow sits at an input box — and it must not arm or release
// the guard itself.
let createPrFromCurrentBranchInFlight = false;

/**
 * Resolves the 1-based editor line an invocation referred to, from the shapes a
 * contributed command can be called with:
 *
 * - `({ lineNumber, uri })` — what `editor/lineNumber/context` sends today: the
 *   menu forwards its `arg` as one argument.
 * - `(uri, lineNumbers, ...)` — the documented order for that menu, where
 *   `lineNumbers` is an array whose first entry is the line nearest the click.
 * - `undefined` when neither argument names a line (editor context menu or
 *   command palette), which lets the caller fall back to the selection.
 *
 * Exported for tests.
 */
export function toLineNumber(first?: unknown, second?: unknown): number | undefined {
  const candidate = isLineNumberArgument(first) ? first.lineNumber : Array.isArray(second) ? second[0] : undefined;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function isLineNumberArgument(value: unknown): value is { lineNumber: number } {
  return (
    typeof value === 'object' && value !== null && typeof (value as { lineNumber?: unknown }).lineNumber === 'number'
  );
}

/**
 * The document uri an invocation names, if any. `editor/lineNumber/context`
 * forwards its `arg` as a single `{ lineNumber, uri }` object, while the
 * documented `(uri, lineNumbers, ...)` order passes the uri itself as the first
 * argument.
 */
function uriArgumentOf(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { scheme?: unknown; uri?: unknown };
  if (typeof candidate.scheme === 'string') {
    return candidate;
  }
  return candidate.uri;
}

/**
 * Whether the uri argument names the same document as `a`.
 *
 * The query is part of a document's identity: `vscode.diff` shows two documents
 * of the same PR file (`ForgejoPrDiffFileSystemProvider`, both sides built by
 * `PullReviewCommentController._buildUri`), and their uris carry the same scheme
 * and path and differ only in the query, which holds `isBase` and `ref`.
 * Comparing the path alone therefore matched whichever side
 * `visibleTextEditors` happened to list first, so a click on the head side could
 * resolve the base editor — whose line table then refused the head line number
 * with "Comments can only be added to lines within the pull request diff".
 *
 * The argument crosses the command bridge as a plain object, so identity and
 * `instanceof` are out; compare the fields a uri carries instead.
 */
function sameDocumentUri(a: vscode.Uri, b: unknown): boolean {
  if (!b || typeof b !== 'object') {
    return false;
  }
  const candidate = b as Partial<vscode.Uri>;
  if (typeof candidate.scheme !== 'string' || candidate.scheme !== a.scheme) {
    return false;
  }
  // A uri spells an absent component as the empty string, so an argument that
  // drops one must not read as a different document.
  if ((candidate.authority ?? '') !== (a.authority ?? '') || (candidate.query ?? '') !== (a.query ?? '')) {
    return false;
  }
  const path = typeof candidate.path === 'string' ? candidate.path : candidate.fsPath;
  return typeof path === 'string' && (path === a.path || path === a.fsPath);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  readmeProvider: ReadmeContentProvider,
  viewProvider: ForgejoToolkitViewProvider,
  pullReviewCommentController: PullReviewCommentController,
) {
  context.subscriptions.push(
    // The view-title refresh, one command per target and one handler for all of
    // them: a command's title is static, so the item whose tooltip names the
    // true target has to be a separate contribution per target, and only the
    // `when` clauses differ (`activeView.ts`, and the Webview UI section of
    // `docs/architecture/README.md`). What the press does is decided by the
    // webview, which routes `refreshData` to the route the reader is on.
    ...REFRESH_VIEW_COMMANDS.map((command) => vscode.commands.registerCommand(command, () => viewProvider.refresh())),

    vscode.commands.registerCommand('forgejoToolkit.openSettings', () => {
      viewProvider.openSettings();
    }),

    // The settings page's own way into VS Code's settings editor, **filtered to
    // this extension** (`docs/design/settings-page.md` §2.1). The unfiltered
    // command would drop the user into every setting the editor has, which is the
    // situation this page exists to answer; and it is a **separate** command from
    // `forgejoToolkit.openSettings` (which opens this page) on purpose, so the
    // palette does not hold two entries whose titles both read "Open Settings".
    //
    // The filter is the extension's **own id**, taken from the running extension
    // rather than typed a second time: `@ext:forgejo-toolkit` — the package name
    // without its publisher — matches nothing, and the editor then opens saying no
    // settings were found. `context.extension.id` is `<publisher>.<name>` as the
    // manifest declares them.
    vscode.commands.registerCommand('forgejoToolkit.openNativeSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    }),

    vscode.commands.registerCommand('forgejoToolkit.openOnboarding', () => {
      OnboardingWebviewPanel.createOrShow(context, context.extensionUri, config, readmeProvider);
    }),

    vscode.commands.registerCommand('forgejoToolkit.openDashboard', () => {
      viewProvider.openDashboard();
    }),

    vscode.commands.registerCommand('forgejoToolkit.copyPermalink', () => {
      copyPermalink(config).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[copyPermalink] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to copy permalink: {0}', err));
      });
    }),

    vscode.commands.registerCommand('forgejoToolkit.copyAgentsWindowMcpConfig', () => {
      copyAgentsWindowMcpConfig(context, logger).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[copyAgentsWindowMcpConfig] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to generate the MCP configuration: {0}', err));
      });
    }),

    vscode.commands.registerCommand('forgejoToolkit.publishToForgejo', () => {
      if (publishToForgejoInFlight) {
        logger.info('[publishToForgejo] Ignored invocation while a publish is already running');
        return;
      }
      publishToForgejoInFlight = true;
      publishToForgejo(config, viewProvider)
        .catch((error: unknown) => {
          const err = userFacingErrorMessage(error);
          logger.error(`[publishToForgejo] ${err}`);
          void showErrorWithLog(vscode.l10n.t('Failed to publish to Forgejo: {0}', err));
        })
        .finally(() => {
          publishToForgejoInFlight = false;
        });
    }),

    vscode.commands.registerCommand('forgejoToolkit.showLog', () => {
      logger.show();
    }),

    vscode.commands.registerCommand(
      'forgejoToolkit.createPrFromCurrentBranch',
      (args?: CreatePrFromCurrentBranchArgs) => {
        // Navigation to an existing PR bypasses the guard entirely: it shares
        // nothing with the create flow, so it is neither blocked by it nor
        // allowed to flip its flag (see the declaration comment).
        const isCreateFlow = typeof args?.index !== 'number';
        if (isCreateFlow) {
          if (createPrFromCurrentBranchInFlight) {
            logger.info('[createPrFromCurrentBranch] Ignored invocation while a create-PR flow is already running');
            return;
          }
          createPrFromCurrentBranchInFlight = true;
        }
        createPrFromCurrentBranch(config, viewProvider, args)
          .catch((error: unknown) => {
            const err = userFacingErrorMessage(error);
            logger.error(`[createPrFromCurrentBranch] ${err}`);
            void showErrorWithLog(vscode.l10n.t('Failed to create pull request: {0}', err));
          })
          .finally(() => {
            if (isCreateFlow) {
              createPrFromCurrentBranchInFlight = false;
            }
          });
      },
    ),

    vscode.commands.registerCommand(COMMAND_ADD_COMMENT, (first?: unknown, second?: unknown) => {
      // The gutter menu passes the document uri along with the clicked line; with
      // several editors visible (a diff editor is two), the active editor is not
      // necessarily the one the click happened on, so resolve the target by uri
      // first and fall back to the active editor (command palette / editor
      // context menu invocations carry no uri).
      const uri = uriArgumentOf(first);
      const byUri = uri
        ? (vscode.window.visibleTextEditors ?? []).find((candidate) => sameDocumentUri(candidate.document.uri, uri))
        : undefined;
      const editor = byUri ?? vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(vscode.l10n.t('No active editor'));
        return;
      }
      // The 1-based line the invocation named, if any. `editor/lineNumber/context`
      // is documented as running the command with (uri, lineNumbers, ...), but the
      // host action currently forwards its `arg` instead, i.e. the single object
      // `{ lineNumber, uri }` (see editorLineNumberMenu.ts / MenuItemAction.run).
      // `toLineNumber` accepts both so the clicked line is honored either way.
      const lineNumber = toLineNumber(first, second);
      // A line number (line-number context menu) always wins: the user
      // right-clicked that line, and a stale non-empty selection elsewhere must
      // not redirect the anchor. With no line number the anchor is left to
      // `addComment` (`undefined`), which is the layer that reads the selection:
      // resolving it to `selection.active.line` here flattened every multi-line
      // selection to a single line, because `addComment` only consults the
      // selection when it was given no line number.
      const line = lineNumber === undefined ? undefined : lineNumber - 1;
      pullReviewCommentController.addComment(editor, line).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[addComment] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to add review comment: {0}', err));
      });
    }),

    vscode.commands.registerCommand('forgejoToolkit.deletePullReviewComment', (comment: vscode.Comment | undefined) => {
      if (!comment?.contextValue) {
        return;
      }
      const context = pullReviewCommentController.getCommentContext(comment.contextValue);
      if (!context) {
        return;
      }
      pullReviewCommentController.deleteComment(context).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[deletePullReviewComment] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to delete review comment: {0}', err));
      });
    }),

    vscode.commands.registerCommand(
      COMMAND_CREATE_ISSUE_FROM_COMMENT,
      (args: CreateIssueFromCommentArgs | undefined) => {
        createIssueFromComment(config, viewProvider, args ?? {}).catch((error: unknown) => {
          const err = userFacingErrorMessage(error);
          logger.error(`[createIssueFromComment] ${err}`);
          void showErrorWithLog(vscode.l10n.t('Failed to create issue from comment: {0}', err));
        });
      },
    ),
  );

  // Registered by its own module: the AI pre-review owns a whole flow (fetch,
  // model call, confirmation list, draft writes) and keeps its single-flight
  // state keyed by pull request rather than the single module-level boolean the
  // two flows above use.
  registerAiPreReviewCommand(context, config, viewProvider, pullReviewCommentController);

  // And the PR-description draft, which shares the seam's selection point with the
  // pre-review and owns its own feature switch, prompt scope and consent question
  // (`docs/design/ai-model-transport.md` §7.6).
  registerPrDescriptionCommand(context, config, viewProvider);

  // And issue triage, which takes the same seam and has its own switch, prompt scope
  // and consent question. It contributes no command: the action needs an issue to
  // name and only the page knows which one is open, so the page's button is the one
  // entry point (`docs/design/issue-triage.md` §7).
  registerIssueTriage(context, config, viewProvider);

  // Likewise the endpoint test: it validates an endpoint locally, makes at most
  // two requests and renders its own report, and it is never called from any
  // automatic path (`docs/design/ai-model-transport.md` §7.2, §8.7).
  registerAiTestProviderCommand(context);
}
