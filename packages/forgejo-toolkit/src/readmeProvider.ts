import * as vscode from 'vscode';
import type { ForgejoClient } from './api/client';
import { logger } from './logger';
import { missingPayloadNotice } from './utils/payloadNotice';

const README_SCHEME = 'cpf23333-forgejo-toolkit-readme';
// Bound the in-memory cache: evict the oldest entry (Maps iterate in
// insertion order) once the limit is reached.
const MAX_README_ENTRIES = 20;

/**
 * The notice to show for a repository whose README the contents API withheld,
 * or undefined when there is nothing to explain.
 *
 * `client.getReadme` reports "no text" both for a repository without a README
 * and for a README above the contents API payload limit (`[api]
 * DEFAULT_MAX_BLOB_SIZE`, 10 MiB by default), where the API omits `content` and
 * reports the real `size` instead. Only the second case has something to say,
 * and it gets the same localized notice the file providers serve.
 */
export async function withheldReadmeNotice(
  client: Pick<ForgejoClient, 'getReadmeEntry'>,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  let entry: { content?: string; size?: number } | undefined;
  try {
    entry = await client.getReadmeEntry(owner, repo);
  } catch (error) {
    // The probe contract is "never throws"; a missing README explanation must
    // not turn a loaded repository into a failed load if that ever changes.
    logger.debug(
      `README entry probe failed for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!entry || entry.content) {
    return undefined;
  }
  return missingPayloadNotice(entry.size);
}

export class ReadmeContentProvider implements vscode.TextDocumentContentProvider {
  private _contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  /**
   * Registers README text and returns the virtual document that serves it.
   *
   * The instance id is part of the path: two instances can host the same
   * owner/repo, and without it both READMEs map to one document, so whichever
   * was cached last would be shown for the other instance. It stays optional
   * because a caller that has no instance context (onboarding) still needs a
   * usable URI.
   */
  public setReadme(owner: string, repo: string, content: string, instanceId?: string): vscode.Uri {
    const path = `${instanceId ? `${instanceId}/` : ''}${owner}/${repo}/README.md`;
    const uri = vscode.Uri.from({ scheme: README_SCHEME, path });
    const key = uri.toString();
    if (!this._contents.has(key) && this._contents.size >= MAX_README_ENTRIES) {
      const oldest = this._contents.keys().next().value;
      if (oldest !== undefined) {
        this._contents.delete(oldest);
      }
    }
    this._contents.set(key, content);
    this._onDidChange.fire(uri);
    return uri;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.toString()) ?? '';
  }
}

let provider: ReadmeContentProvider | undefined;

export function registerReadmeProvider(context: vscode.ExtensionContext): ReadmeContentProvider {
  if (!provider) {
    provider = new ReadmeContentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(README_SCHEME, provider));
  }
  return provider;
}

export function openReadmePreview(
  provider: ReadmeContentProvider,
  owner: string,
  repo: string,
  content: string,
  instanceId?: string,
) {
  const uri = provider.setReadme(owner, repo, content, instanceId);
  void vscode.commands.executeCommand('markdown.showPreviewToSide', uri).then(undefined, (error: unknown) => {
    logger.error(
      `Failed to open README preview for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export { README_SCHEME };
