import * as vscode from 'vscode';
import type { ConfigManager } from '../config';
import { ForgejoClient } from '../api/client';
import { detectLinkedRepositories, isPathInsideFolder } from '../worktree/gitOperations';
import type { LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { logger } from '../logger';
import { stripUrlUserinfo } from '../utils/redactUrlUserinfo';

interface RepoContext {
  instanceId: string;
  owner: string;
  repo: string;
  instanceUrl: string;
}

const ISSUE_MENTION_REGEX = /#(\d+)/g;
// A username may contain `-`, `_` and `.` (Forgejo allows all three), but a
// trailing `.` is sentence punctuation: `@alice.` names `alice`, not the user
// `alice.`. Dots are therefore only accepted between word characters, so the
// match can neither swallow a following `.` nor run past `..`.
const USER_MENTION_REGEX = /@([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/g;

const MENTION_CACHE_TTL_MS = 60_000;
// Completion lists are only dropped from the cache when their key is read again
// after expiry, so a user visiting many repositories would keep every list for
// the rest of the session. Bound it, evicting expired entries first.
const MENTION_CACHE_MAX_ENTRIES = 50;

/**
 * Line-local heuristic deciding whether a `#`/`@` can start a mention, used by
 * both completions and document links. The providers are registered for every
 * `file` document, so without this a Python `# comment`, a C `#include`, or a
 * line-start `@decorator` would trigger issue/user suggestions.
 *
 * A trigger with any non-whitespace text before it on the line is treated as
 * in-prose and allowed. A trigger at line start (only whitespace before) is
 * usually a comment/directive/decorator/at-rule and is rejected — except `#`
 * directly followed by a digit, which is still an issue reference (`#123`).
 * The remaining false positive (a `#` mid-line comment in a comment-heavy
 * language) is accepted as the cost of staying language-agnostic.
 */
export function isMentionTriggerContext(lineText: string, triggerIndex: number, trigger: '#' | '@'): boolean {
  if (/\S/.test(lineText.slice(0, triggerIndex))) {
    return true;
  }
  if (trigger === '#') {
    return /\d/.test(lineText.charAt(triggerIndex + 1));
  }
  return false;
}

// Mirror the attribution rule in detectLinkedRepositories: the repository
// containing the document wins; longest path first so a nested repository
// beats its enclosing one. Without a containing match, fall back to the first
// linked repository (the passive-caller default). Attribution happens locally
// against the `all` list, so several workspace repositories each get their own
// repo context instead of sharing whichever repository matched first; the
// expensive scan behind detectLinkedRepositories is cached there (short TTL),
// so this per-render call does not respawn git probes.
function attributeLinkedRepository(all: LinkedRepository[], fsPath: string): LinkedRepository | undefined {
  if (all.length === 0) {
    return undefined;
  }
  const containing = all
    .filter((m) => m.localPath === fsPath || isPathInsideFolder(m.localPath, fsPath))
    .sort((a, b) => b.localPath.length - a.localPath.length);
  return containing[0] ?? all[0];
}

interface MentionCacheEntry {
  value: unknown[];
  expiresAt: number;
}

async function getRepoContext(document: vscode.TextDocument, config: ConfigManager): Promise<RepoContext | undefined> {
  // Only `file` documents are supported: extension.ts registers this provider
  // with `{ scheme: 'file' }`, so forgejo-pr virtual documents never reach it.
  if (document.uri.scheme === 'file') {
    const linked = attributeLinkedRepository(
      (await detectLinkedRepositories(config.getInstances())).all,
      document.uri.fsPath,
    );
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
      // DocumentLink targets are opened in a browser, so the credentials a
      // configured instance URL may embed as userinfo are stripped here, once,
      // before any link is built from them — a masked `***@host` would leave a
      // link the editor cannot open. The helper re-serializes an absolute URL
      // (a trailing slash appears), so the trailing slash is trimmed here rather
      // than at each of the two concatenation sites.
      instanceUrl: stripUrlUserinfo(instance.url).replace(/\/$/, ''),
    };
  }

  return undefined;
}

export function getMentionRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
  const line = document.lineAt(position.line);
  const text = line.text;
  let start = position.character;
  // Walk back over word characters only. Swallowing `#`/`@` here would let the
  // range eat a preceding word (e.g. `foo@` would replace `foo@` instead of
  // just `@`).
  while (start > 0 && /[a-zA-Z0-9_.-]/.test(text[start - 1])) {
    start -= 1;
  }
  // Include a directly preceding trigger character so the completion's
  // insertText (`#123` / `@user`) replaces it instead of duplicating it.
  if (start > 0 && (text[start - 1] === '#' || text[start - 1] === '@')) {
    start -= 1;
  }
  return new vscode.Range(position.line, start, position.line, position.character);
}

export class ForgejoIssueMentionProvider implements vscode.DocumentLinkProvider, vscode.CompletionItemProvider {
  private readonly mentionCache = new Map<string, MentionCacheEntry>();

  constructor(private readonly config: ConfigManager) {}

  /**
   * Fetch a completion list with a short per-repo TTL cache. Failures are not
   * cached so a transient error does not blank completions for a minute.
   */
  private async getCachedList<T>(
    kind: 'issues' | 'prs' | 'assignees',
    context: RepoContext,
    fetcher: () => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${kind}:${context.instanceId}/${context.owner}/${context.repo}`;
    const entry = this.mentionCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T[];
    }
    this.mentionCache.delete(key);
    try {
      const value = await fetcher();
      this.mentionCache.set(key, { value, expiresAt: Date.now() + MENTION_CACHE_TTL_MS });
      this._enforceMentionCacheBound();
      return value;
    } catch {
      return [];
    }
  }

  /**
   * Keep the completion cache bounded: drop everything already expired, then
   * the oldest entries (Map iteration is insertion-ordered) until it fits.
   */
  private _enforceMentionCacheBound(): void {
    if (this.mentionCache.size <= MENTION_CACHE_MAX_ENTRIES) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of this.mentionCache) {
      if (entry.expiresAt <= now) {
        this.mentionCache.delete(key);
      }
    }
    while (this.mentionCache.size > MENTION_CACHE_MAX_ENTRIES) {
      const oldest = this.mentionCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.mentionCache.delete(oldest);
    }
  }

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
    // `#` links need no extra context check: the regex already requires a
    // digit right after `#`, which is exactly the mention shape kept by
    // isMentionTriggerContext (`#include` / `# comment` never match).
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
      // Skip email addresses: a word character directly before `@` means this
      // is not a user mention (e.g. `foo@bar.com`).
      if (match.index > 0 && /[a-zA-Z0-9_.-]/.test(text[match.index - 1])) {
        continue;
      }
      const start = document.positionAt(match.index);
      // Skip line-start `@token` (decorators, at-rules): only whitespace
      // before `@` on the line means this is not an in-prose mention.
      if (!isMentionTriggerContext(document.lineAt(start.line).text, start.character, '@')) {
        continue;
      }
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

    // Line-start triggers are comments/directives/decorators, not mentions:
    // require in-prose context (see isMentionTriggerContext). At trigger time
    // nothing follows the just-typed character yet, so the `#`+digit escape
    // only matters for document links; line-start `#123` still gets linked.
    const triggerIndex = position.character - 1;
    const lineText = document.lineAt(position.line).text;
    if (triggerIndex < 0 || !isMentionTriggerContext(lineText, triggerIndex, trigger)) {
      return [];
    }

    // Do not offer user completions inside an email address: when `@` was just
    // typed, the character before it being a word character means this is
    // something like `foo@bar.com`, not a mention.
    if (trigger === '@' && position.character >= 2) {
      if (/[a-zA-Z0-9_.-]/.test(lineText[position.character - 2])) {
        return [];
      }
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
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);

      if (trigger === '#') {
        const [issues, pullRequests] = await Promise.all([
          this.getCachedList('issues', context, () => client.getRepoIssues(context.owner, context.repo, 'open')),
          this.getCachedList('prs', context, () => client.getRepoPullRequests(context.owner, context.repo, 'open')),
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
          item.detail = vscode.l10n.t('Issue');
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
          item.detail = vscode.l10n.t('Pull Request');
          items.push(item);
        }
      } else {
        const users = await this.getCachedList('assignees', context, () =>
          client.getRepoAssignees(context.owner, context.repo),
        );
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
