import * as vscode from 'vscode';
import * as path from 'path';
import type { ConfigManager } from '../config';
import { detectLinkedRepository, getCurrentCommitSha } from '../worktree/gitOperations';
import { encodePermalinkPath } from '../commands/permalink';
import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';

export const COMMAND_CREATE_ISSUE_FROM_COMMENT = 'forgejoToolkit.createIssueFromComment';

export interface TodoComment {
  marker: 'TODO' | 'FIXME';
  text: string;
}

// Common comment delimiters the marker may directly follow. `*` covers block
// comment continuation lines; it can also be a multiplication operator, which
// is accepted as the cost of staying language-agnostic (the action is shown
// on demand only, never auto-applied).
const COMMENT_PREFIXES = ['//', '/*', '*', '#', '<!--', '--', ';', '%'];

/**
 * Extract a TODO/FIXME marker and its trailing text from a line. To avoid
 * false positives (identifiers like `todoCount`, strings mentioning TODO in
 * prose), the marker must be a whole word placed at line start (after
 * whitespace) or directly after a common comment delimiter, and some text
 * must follow it to serve as the issue title. The text may start immediately
 * after the marker or its colon (`TODO:123` is as valid as `TODO: 123`).
 */
export function extractTodoComment(lineText: string): TodoComment | undefined {
  const match = /\b(TODO|FIXME)\b(?::\s*|\s+)(.+)$/.exec(lineText);
  if (!match) {
    return undefined;
  }
  const before = lineText.slice(0, match.index).trimEnd();
  const inComment = before === '' || COMMENT_PREFIXES.some((prefix) => before.endsWith(prefix));
  if (!inComment) {
    return undefined;
  }
  const text = match[2].trim();
  if (!text) {
    return undefined;
  }
  return { marker: match[1] as TodoComment['marker'], text };
}

export interface CreateIssueFromCommentArgs {
  fsPath?: string;
  line?: number;
  text?: string;
}

/**
 * Offers a "Create Issue from TODO/FIXME comment" quick fix on lines whose
 * comment contains a TODO/FIXME marker. Registered for every `file` document;
 * extraction is line-local and cheap, so no caching is needed.
 */
export class TodoCommentCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (let line = range.start.line; line <= range.end.line; line++) {
      const todo = extractTodoComment(document.lineAt(line).text);
      if (!todo) {
        continue;
      }
      const action = new vscode.CodeAction(
        vscode.l10n.t('Create Issue from {0} comment', todo.marker),
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        command: COMMAND_CREATE_ISSUE_FROM_COMMENT,
        title: action.title,
        arguments: [{ fsPath: document.uri.fsPath, line, text: todo.text } satisfies CreateIssueFromCommentArgs],
      };
      actions.push(action);
    }
    return actions;
  }
}

/**
 * Open the dashboard's new-issue form prefilled from a TODO/FIXME comment:
 * the comment text becomes the title, the body links back to the source line
 * via a permalink (falling back to a plain `path:line` reference when the
 * commit SHA is unavailable).
 */
export async function createIssueFromComment(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
  args: CreateIssueFromCommentArgs,
): Promise<void> {
  if (!args?.fsPath || typeof args.line !== 'number' || !args.text) {
    return;
  }
  // Attribute to the repository containing the commented file so nested
  // repositories in the same workspace resolve to their own remote.
  const linked = await detectLinkedRepository(config.getInstances(), { preferredPath: args.fsPath });
  if (!linked) {
    vscode.window.showWarningMessage(vscode.l10n.t('No linked Forgejo repository found for the current workspace'));
    return;
  }
  const instance = config.getInstances().find((i) => i.id === linked.instanceId);
  if (!instance) {
    vscode.window.showWarningMessage(vscode.l10n.t('Forgejo instance not found'));
    return;
  }
  const relativePath = path.relative(linked.localPath, args.fsPath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) {
    vscode.window.showWarningMessage(vscode.l10n.t('The current file is outside the linked repository'));
    return;
  }
  const lineNumber = args.line + 1;
  const sha = await getCurrentCommitSha(linked.localPath);
  // This reference becomes the *body* of a new issue, so it is persisted
  // server-side and readable by everyone with repository access: a credential
  // embedded in the configured instance URL must never be part of it.
  const reference = sha
    ? `${redactUrlUserinfo(instance.url).replace(/\/$/, '')}/${linked.owner}/${linked.repo}/blob/${sha}/${encodePermalinkPath(relativePath)}#L${lineNumber}`
    : `${relativePath}#L${lineNumber}`;

  await vscode.commands.executeCommand('forgejoToolkitView.focus');
  viewProvider.openNewIssue({
    instanceId: linked.instanceId,
    owner: linked.owner,
    repo: linked.repo,
    title: args.text,
    body: reference,
  });
}
