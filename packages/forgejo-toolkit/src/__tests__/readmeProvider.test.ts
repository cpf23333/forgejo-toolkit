import { describe, it, expect, vi } from 'vitest';
import { ReadmeContentProvider, withheldReadmeNotice } from '../readmeProvider';

const MIB = 1024 * 1024;

describe('withheldReadmeNotice', () => {
  it('explains a README whose payload the contents API omitted', async () => {
    // The API answers with the real size and no content for a README above its
    // payload limit; without the notice the dashboard showed nothing at all.
    const notice = await withheldReadmeNotice({ getReadmeEntry: vi.fn(async () => ({ size: 12 * MIB })) }, 'o', 'r');
    expect(notice).toContain('MiB');
    expect(notice).toContain('12.0');
  });

  it('returns no notice for a repository without a README', async () => {
    expect(await withheldReadmeNotice({ getReadmeEntry: vi.fn(async () => undefined) }, 'o', 'r')).toBeUndefined();
  });

  it('returns no notice for an empty README', async () => {
    expect(await withheldReadmeNotice({ getReadmeEntry: vi.fn(async () => ({ size: 0 })) }, 'o', 'r')).toBeUndefined();
  });

  it('returns no notice when the entry carries the text', async () => {
    expect(
      await withheldReadmeNotice({ getReadmeEntry: vi.fn(async () => ({ content: '# Hi', size: 7 })) }, 'o', 'r'),
    ).toBeUndefined();
  });

  it('never turns a failing probe into a failed repository load', async () => {
    expect(
      await withheldReadmeNotice(
        {
          getReadmeEntry: vi.fn(async () => {
            throw new Error('network down');
          }),
        },
        'o',
        'r',
      ),
    ).toBeUndefined();
  });
});

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
