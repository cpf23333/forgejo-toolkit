import * as vscode from 'vscode';
import type { ConfigManager } from '../config';
import { ForgejoClient } from '../api/client';
import { detectLinkedRepository } from '../worktree/gitOperations';
import { FORGEJO_PR_SCHEME, type ForgejoPrUriParams } from '../prFileSystemProvider';
import { logger } from '../logger';

interface RepoContext {
  instanceId: string;
  owner: string;
  repo: string;
  instanceUrl: string;
}

const ISSUE_MENTION_REGEX = /#(\d+)/g;
const USER_MENTION_REGEX = /@([a-zA-Z0-9_.-]+)/g;

function parseForgejoPrUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
  if (uri.scheme !== FORGEJO_PR_SCHEME || !uri.query) {
    return undefined;
  }
  try {
    const query = JSON.parse(uri.query) as Partial<ForgejoPrUriParams>;
    const pathMatch = uri.path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!pathMatch) {
      return undefined;
    }
    const [, instanceId, owner, repo, filepath] = pathMatch;
    const index = typeof query.index === 'number' ? query.index : Number(query.index);
    return {
      instanceId,
      owner,
      repo,
      index: Number.isNaN(index) ? 0 : index,
      ref: query.ref ?? '',
      path: filepath,
      isBase: query.isBase ?? false,
      status: query.status,
    };
  } catch {
    return undefined;
  }
}

async function getRepoContext(document: vscode.TextDocument, config: ConfigManager): Promise<RepoContext | undefined> {
  if (document.uri.scheme === FORGEJO_PR_SCHEME) {
    const params = parseForgejoPrUri(document.uri);
    if (!params) {
      return undefined;
    }
    const instance = config.getInstances().find((i) => i.id === params.instanceId);
    if (!instance) {
      return undefined;
    }
    return {
      instanceId: params.instanceId,
      owner: params.owner,
      repo: params.repo,
      instanceUrl: instance.url,
    };
  }

  if (document.uri.scheme === 'file') {
    const linked = await detectLinkedRepository(config.getInstances());
    if (!linked) {
      return undefined;
    }
    const instance = config.getInstances().find((i) => i.id === linked.instanceId);
    if (!instance) {
      return undefined;
    }
    return {
      instanceId: linked.instanceId,
      owner: linked.owner,
      repo: linked.repo,
      instanceUrl: instance.url,
    };
  }

  return undefined;
}

function getMentionRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
  const line = document.lineAt(position.line);
  const text = line.text;
  let start = position.character;
  while (start > 0) {
    const char = text[start - 1];
    if (char === '#' || char === '@' || /[a-zA-Z0-9_.-]/.test(char)) {
      start -= 1;
    } else {
      break;
    }
  }
  return new vscode.Range(position.line, start, position.line, position.character);
}

export class ForgejoIssueMentionProvider implements vscode.DocumentLinkProvider, vscode.CompletionItemProvider {
  constructor(private readonly config: ConfigManager) {}

  async provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const context = await getRepoContext(document, this.config);
    if (!context) {
      return [];
    }

    const baseUrl = context.instanceUrl.replace(/\/$/, '');
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();

    let match: RegExpExecArray | null;
    ISSUE_MENTION_REGEX.lastIndex = 0;
    while ((match = ISSUE_MENTION_REGEX.exec(text)) !== null) {
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + match[0].length);
      const link = new vscode.DocumentLink(new vscode.Range(start, end));
      const number = match[1];
      link.target = vscode.Uri.parse(`${baseUrl}/${context.owner}/${context.repo}/issues/${number}`);
      link.tooltip = vscode.l10n.t('Open issue/PR #{0}', number);
      links.push(link);
    }

    USER_MENTION_REGEX.lastIndex = 0;
    while ((match = USER_MENTION_REGEX.exec(text)) !== null) {
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + match[0].length);
      const link = new vscode.DocumentLink(new vscode.Range(start, end));
      const username = match[1];
      link.target = vscode.Uri.parse(`${baseUrl}/${username}`);
      link.tooltip = vscode.l10n.t('Open user profile @{0}', username);
      links.push(link);
    }

    return links;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    completionContext: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[]> {
    const trigger = completionContext.triggerCharacter;
    if (trigger !== '#' && trigger !== '@') {
      return [];
    }

    const context = await getRepoContext(document, this.config);
    if (!context) {
      return [];
    }

    const instance = this.config.getInstances().find((i) => i.id === context.instanceId);
    if (!instance) {
      return [];
    }

    const range = getMentionRange(document, position);
    const items: vscode.CompletionItem[] = [];

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger);

      if (trigger === '#') {
        const [issues, pullRequests] = await Promise.all([
          client.getRepoIssues(context.owner, context.repo, 'open').catch(() => []),
          client.getRepoPullRequests(context.owner, context.repo, 'open').catch(() => []),
        ]);
        const seen = new Set<number>();
        for (const issue of issues) {
          if (issue.number === undefined || seen.has(issue.number)) {
            continue;
          }
          seen.add(issue.number);
          const item = new vscode.CompletionItem(`#${issue.number} ${issue.title}`, vscode.CompletionItemKind.Issue);
          item.insertText = `#${issue.number}`;
          item.range = range;
          item.detail = 'Issue';
          items.push(item);
        }
        for (const pr of pullRequests) {
          if (pr.number === undefined || seen.has(pr.number)) {
            continue;
          }
          seen.add(pr.number);
          const item = new vscode.CompletionItem(`#${pr.number} ${pr.title}`, vscode.CompletionItemKind.Issue);
          item.insertText = `#${pr.number}`;
          item.range = range;
          item.detail = 'Pull Request';
          items.push(item);
        }
      } else {
        const users = await client.getRepoAssignees(context.owner, context.repo).catch(() => []);
        for (const username of users) {
          const item = new vscode.CompletionItem(`@${username}`, vscode.CompletionItemKind.User);
          item.insertText = `@${username}`;
          item.range = range;
          items.push(item);
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`Completion provider failed for ${context.owner}/${context.repo}: ${err}`);
    }

    return items;
  }
}
