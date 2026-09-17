import * as vscode from 'vscode';
import { logger } from './logger';

const README_SCHEME = 'cpf23333-forgejo-toolkit-readme';
// Bound the in-memory cache: evict the oldest entry (Maps iterate in
// insertion order) once the limit is reached.
const MAX_README_ENTRIES = 20;

export class ReadmeContentProvider implements vscode.TextDocumentContentProvider {
  private _contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  public setReadme(owner: string, repo: string, content: string): vscode.Uri {
    const path = `${owner}/${repo}/README.md`;
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

export function openReadmePreview(provider: ReadmeContentProvider, owner: string, repo: string, content: string) {
  const uri = provider.setReadme(owner, repo, content);
  void vscode.commands.executeCommand('markdown.showPreviewToSide', uri).then(undefined, (error: unknown) => {
    logger.error(
      `Failed to open README preview for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export { README_SCHEME };
