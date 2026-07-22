import * as vscode from 'vscode';

const README_SCHEME = 'cpf23333-forgejo-toolkit-readme';

export class ReadmeContentProvider implements vscode.TextDocumentContentProvider {
  private _contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  public setReadme(owner: string, repo: string, content: string): vscode.Uri {
    const path = `${owner}/${repo}/README.md`;
    const uri = vscode.Uri.from({ scheme: README_SCHEME, path });
    this._contents.set(uri.toString(), content);
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
  void vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

export { README_SCHEME };
