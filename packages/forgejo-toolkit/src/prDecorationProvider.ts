import * as vscode from 'vscode';
import { FORGEJO_PR_SCHEME, ForgejoPrUriParams } from './prFileSystemProvider';

function parseUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
  if (uri.scheme !== FORGEJO_PR_SCHEME || !uri.query) {
    return undefined;
  }
  try {
    return JSON.parse(uri.query) as ForgejoPrUriParams;
  } catch {
    return undefined;
  }
}

function statusLetter(status?: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'removed':
      return 'D';
    case 'renamed':
      return 'R';
    case 'changed':
    case 'modified':
    default:
      return 'M';
  }
}

function statusColor(status?: string): vscode.ThemeColor | undefined {
  switch (status) {
    case 'added':
      return new vscode.ThemeColor('gitDecoration.addedResourceForeground');
    case 'removed':
      return new vscode.ThemeColor('gitDecoration.deletedResourceForeground');
    case 'renamed':
      return new vscode.ThemeColor('gitDecoration.renamedResourceForeground');
    case 'changed':
    case 'modified':
    default:
      return new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
  }
}

export class ForgejoPRDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const params = parseUri(uri);
    if (!params || !params.status) {
      return undefined;
    }
    return {
      badge: statusLetter(params.status),
      color: statusColor(params.status),
      propagate: false,
    };
  }
}
