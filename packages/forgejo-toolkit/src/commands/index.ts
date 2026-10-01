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
import { logger, showErrorWithLog } from '../logger';
import { userFacingErrorMessage } from '../api/errors';

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
    vscode.commands.registerCommand('forgejoToolkit.refreshInstances', () => {
      viewProvider.refresh();
    }),

    vscode.commands.registerCommand('forgejoToolkit.openSettings', () => {
      viewProvider.openSettings();
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
      // not redirect the anchor. The selection is only consulted when no line
      // number was passed (editor context menu / command palette).
      const line = lineNumber === undefined ? editor.selection.active.line : lineNumber - 1;
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
}
