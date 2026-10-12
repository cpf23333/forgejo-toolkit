import * as vscode from 'vscode';
import { logger } from '../logger';
import { userFacingErrorMessage } from '../api/errors';
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

/** The row families the markers publish. */
export const WEBVIEW_CONTEXT_MENU_SECTIONS = [
  'repositoryRow',
  'pullRequestRow',
  'issueRow',
  'notificationRow',
] as const;

/** One value of {@link WEBVIEW_CONTEXT_MENU_SECTIONS}. */
export type WebviewContextMenuSection = (typeof WEBVIEW_CONTEXT_MENU_SECTIONS)[number];

/** The command ids contributed under `webview/context`. */
export const WEBVIEW_CONTEXT_MENU_COMMANDS = {
  openRepositoryRow: 'forgejoToolkit.openRepositoryRow',
  copyRepositoryAddress: 'forgejoToolkit.copyRepositoryAddress',
  openIssueRow: 'forgejoToolkit.openIssueRow',
  openPullRequestRow: 'forgejoToolkit.openPullRequestRow',
  copyRowReference: 'forgejoToolkit.copyRowReference',
  openRowInBrowser: 'forgejoToolkit.openRowInBrowser',
  markNotificationRowRead: 'forgejoToolkit.markNotificationRowRead',
} as const;

/** One row's identity, after validation. */
export interface RowTarget {
  section: WebviewContextMenuSection;
  instanceId: string;
  owner?: string;
  repo?: string;
  index?: number;
  notificationId?: number;
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
  // VS Code adds `webview` from the webview's own view type; requiring it here means
  // a stale contribution for another surface can never reach these actions.
  if (argument.webview !== WEBVIEW_CONTEXT_MENU_VIEW_ID) {
    return undefined;
  }
  const section = WEBVIEW_CONTEXT_MENU_SECTIONS.find((candidate) => candidate === argument.webviewSection);
  if (section === undefined) {
    return undefined;
  }
  const instanceId = typeof argument.forgejoInstanceId === 'string' ? argument.forgejoInstanceId : '';
  if (instanceId === '') {
    return undefined;
  }
  const owner = safeSegment(argument.forgejoOwner);
  const repo = safeSegment(argument.forgejoRepo);
  const index = positiveInteger(argument.forgejoIndex);
  const notificationId = positiveInteger(argument.forgejoNotificationId);
  switch (section) {
    case 'repositoryRow':
      // A repository row names a repository and nothing else.
      return owner !== undefined && repo !== undefined ? { section, instanceId, owner, repo } : undefined;
    case 'issueRow':
    case 'pullRequestRow':
      return owner !== undefined && repo !== undefined && index !== undefined
        ? { section, instanceId, owner, repo, index }
        : undefined;
    case 'notificationRow':
      // A notification row always carries its own id; the open items need the
      // coordinates, and their `when` clauses only match a row that has them.
      return notificationId !== undefined
        ? {
            section,
            instanceId,
            notificationId,
            ...(owner !== undefined && repo !== undefined && index !== undefined ? { owner, repo, index } : {}),
          }
        : undefined;
  }
}

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
  if (target.owner === undefined || target.repo === undefined || target.index === undefined) {
    return undefined;
  }
  const prefix = target.section === 'pullRequestRow' ? 'pulls' : 'issues';
  return `${urlSegment(target.owner)}/${urlSegment(target.repo)}/${prefix}/${target.index}`;
}

/**
 * Registers the contributed items' handlers.
 *
 * Every action reuses what already exists: the navigation messages are the same ones
 * the sidebar's own clicks use (the three `reveal*` methods), the notification read is
 * the provider's own notification path, and the copy/browser items are `vscode.env`
 * calls. Nothing here writes to the server except marking one notification read, which
 * is the item's whole purpose.
 */
export function registerWebviewContextMenuCommands(viewProvider: ForgejoToolkitViewProvider): vscode.Disposable[] {
  const withTarget = (command: string, run: (target: RowTarget) => void | Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(command, (argument?: unknown) => {
      const target = readRowTarget(argument);
      if (target === undefined) {
        logger.debug(`${command}: refused a context-menu argument this view did not publish`);
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
      if (target.owner !== undefined && target.repo !== undefined) {
        viewProvider.revealRepositoryDetail({
          instanceId: target.instanceId,
          owner: target.owner,
          repo: target.repo,
        });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRepositoryAddress, async (target) => {
      if (target.owner === undefined || target.repo === undefined) {
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
      if (target.owner !== undefined && target.repo !== undefined && target.index !== undefined) {
        viewProvider.revealIssueDetail({
          instanceId: target.instanceId,
          owner: target.owner,
          repo: target.repo,
          index: target.index,
        });
      }
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow, (target) => {
      if (target.owner !== undefined && target.repo !== undefined && target.index !== undefined) {
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
      if (target.owner === undefined || target.repo === undefined || target.index === undefined) {
        return;
      }
      // The reference format the row's own copy button already produces.
      await vscode.env.clipboard.writeText(`${target.owner}/${target.repo}#${target.index}`);
    }),

    withTarget(WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser, async (target) => {
      const path = browserPath(target);
      if (path === undefined) {
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
      if (target.notificationId === undefined) {
        return;
      }
      const marked = await viewProvider.markNotificationRead(target.instanceId, target.notificationId);
      if (!marked) {
        logger.debug('markNotificationRowRead: the row names an instance this window no longer has');
      }
    }),
  ];
}
