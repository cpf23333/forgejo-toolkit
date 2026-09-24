import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { README_SCHEME, ReadmeContentProvider, registerReadmeProvider } from '../readmeProvider';

describe('ReadmeContentProvider README documents', () => {
  it('keys the document by instance as well as owner/repo', () => {
    // Two instances can host the same owner/repo; without the instance id both
    // READMEs resolve to one document and the second registration overwrites
    // the first instance's text.
    const provider = new ReadmeContentProvider();
    const first = provider.setReadme('owner', 'repo', 'first instance', 'inst-a');
    const second = provider.setReadme('owner', 'repo', 'second instance', 'inst-b');

    expect(first.toString()).not.toBe(second.toString());
    expect(provider.provideTextDocumentContent(first)).toBe('first instance');
    expect(provider.provideTextDocumentContent(second)).toBe('second instance');
  });

  it('keeps the owner/repo path for callers without an instance context', () => {
    const provider = new ReadmeContentProvider();
    const uri = provider.setReadme('owner', 'repo', 'text');
    expect(uri.toString()).toContain('/owner/repo/README.md');
  });
});

describe('registerReadmeProvider activation lifecycle', () => {
  it('serves the scheme again after a deactivate → activate cycle, and never twice per activation', () => {
    const register = vi.fn((_scheme: string, _provider: unknown) => ({ dispose: vi.fn() }));
    (
      vscode.workspace as unknown as { registerTextDocumentContentProvider: typeof register }
    ).registerTextDocumentContentProvider = register;

    function createContext(): vscode.ExtensionContext {
      return { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
    }

    const firstContext = createContext();
    const first = registerReadmeProvider(firstContext);
    // A second call in the same activation must reuse the provider: VS Code
    // rejects a second provider for a scheme that already has one.
    expect(registerReadmeProvider(firstContext)).toBe(first);
    expect(register).toHaveBeenCalledTimes(1);

    // Deactivate: VS Code disposes the activation's subscriptions, which is
    // what has to drop the module-level guard (the module itself survives the
    // disable/enable cycle).
    while (firstContext.subscriptions.length) {
      firstContext.subscriptions.pop()!.dispose();
    }

    const secondContext = createContext();
    const second = registerReadmeProvider(secondContext);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1]![0]).toBe(README_SCHEME);
    // The scheme stays served after reactivation instead of being left without
    // a provider (which is what made the README previews unable to open).
    const uri = second.setReadme('owner', 'repo', 'after reactivation', 'inst-a');
    expect(second.provideTextDocumentContent(uri)).toBe('after reactivation');
    expect(second).not.toBe(first);
  });
});
