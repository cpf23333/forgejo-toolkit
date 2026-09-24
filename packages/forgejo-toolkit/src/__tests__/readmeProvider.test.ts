import { describe, it, expect } from 'vitest';
import { ReadmeContentProvider } from '../readmeProvider';

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
