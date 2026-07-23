import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { logger } from './logger';

export class ForgejoDiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'forgejo-diff';

  constructor(private readonly _config: ConfigManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { instanceId, owner, repo, ref, filepath } = this._parseUri(uri);
    const instance = this._config.getInstances().find((i) => i.id === instanceId);
    if (!instance) {
      throw new Error(`Forgejo instance not found: ${instanceId}`);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger);
      return await client.getFileContent(owner, repo, filepath, ref);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes('404')) {
        // File does not exist at the requested ref (e.g. added/removed files in a PR).
        return '';
      }
      logger.error(`Failed to fetch Forgejo diff content for ${uri.toString()}: ${err}`);
      throw new Error(`Failed to fetch ${filepath}@${ref}: ${err}`);
    }
  }

  private _parseUri(uri: vscode.Uri): {
    instanceId: string;
    owner: string;
    repo: string;
    ref: string;
    filepath: string;
  } {
    // URI format: forgejo-diff://<instanceId>/<owner>/<repo>/<ref>/<filepath...>
    const parts = uri.path.split('/').filter(Boolean);
    if (parts.length < 4) {
      throw new Error(`Invalid forgejo-diff URI: ${uri.toString()}`);
    }
    const [instanceId, owner, repo, ref, ...filepathParts] = parts;
    return {
      instanceId: decodeURIComponent(instanceId),
      owner: decodeURIComponent(owner),
      repo: decodeURIComponent(repo),
      ref: decodeURIComponent(ref),
      filepath: filepathParts.map(decodeURIComponent).join('/'),
    };
  }
}
