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
  if (provider) {
    return provider;
  }
  const instance = new ReadmeContentProvider();
  provider = instance;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(README_SCHEME, instance),
    // The module-level guard above outlives a deactivate→activate cycle (the
    // extension host keeps the module loaded when the extension is disabled
    // and enabled again), so it must be dropped when the activation ends.
    // `context.subscriptions` is disposed exactly then; without this reset the
    // next activation would skip registration and the
    // `cpf23333-forgejo-toolkit-readme:` scheme would be left without a
    // provider, so "Preview README" and the wizard's README preview could not
    // open. Keeping the guard also means the scheme is never registered twice
    // within one activation, which VS Code rejects.
    {
      dispose: () => {
        if (provider === instance) {
          provider = undefined;
        }
      },
    },
  );
  return instance;
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
