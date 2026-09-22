import { describe, it, expect, vi, beforeEach } from 'vitest';

// Own vscode mock: the shared extension-setup mock lacks DocumentLink, and the
// provider only needs a small surface.
vi.mock('vscode', () => ({
  DocumentLink: class {
    target: unknown;
    tooltip: string | undefined;
    constructor(public range: unknown) {}
  },
  Range: class {
    args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  },
  Uri: {
    parse: vi.fn((s: string) => ({ toString: () => s })),
  },
  l10n: { t: (m: string) => m },
}));

vi.mock('../../worktree/gitOperations', () => ({
  detectLinkedRepositories: vi.fn(),
  isPathInsideFolder: (folder: string, file: string) =>
    typeof folder === 'string' && typeof file === 'string' && file.startsWith(folder),
}));

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ForgejoIssueMentionProvider, getMentionRange, isMentionTriggerContext } from '../issueMentionProvider';
import { detectLinkedRepositories } from '../../worktree/gitOperations';
import type { ConfigManager } from '../../config';

const INSTANCE_URL = 'https://forgejo.example.com';

function linkedResult(instanceId: string) {
  const linked = { instanceId, owner: 'owner', repo: 'repo', localPath: '/repo', remoteUrl: INSTANCE_URL };
  return { linked, all: [linked] };
}

function createConfig(ids: string[]): ConfigManager {
  return {
    getInstances: () =>
      ids.map((id) => ({
        id,
        url: INSTANCE_URL,
        token: '',
        name: `user@${id}`,
        username: 'user',
      })),
  } as unknown as ConfigManager;
}

function makeFileDocument(text: string) {
  const lines = text.split('\n');
  return {
    uri: { scheme: 'file' },
    getText: () => text,
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return { line: i, character: remaining };
        }
        remaining -= lines[i].length + 1;
      }
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    },
    lineAt: (line: number) => ({ text: lines[line] }),
  };
}

const detectMock = vi.mocked(detectLinkedRepositories);

describe('ForgejoIssueMentionProvider linked repository attribution', () => {
  beforeEach(() => {
    detectMock.mockReset();
    detectMock.mockResolvedValue(linkedResult('inst-a') as never);
  });

  it('resolves the repo context from the shared detection result on every call', async () => {
    // The scan-level cache lives inside detectLinkedRepositories itself; the
    // provider consults it per render instead of keeping its own cache.
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-a']));
    const document = makeFileDocument('see #1');

    const first = await provider.provideDocumentLinks(document as never, {} as never);
    const second = await provider.provideDocumentLinks(document as never, {} as never);

    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('attributes the document to the repository containing its path, not the first match', async () => {
    const repoA = {
      instanceId: 'inst-f',
      owner: 'owner',
      repo: 'repo-a',
      localPath: '/ws/repo-a',
      remoteUrl: INSTANCE_URL,
    };
    const repoB = {
      instanceId: 'inst-f',
      owner: 'owner',
      repo: 'repo-b',
      localPath: '/ws/repo-b',
      remoteUrl: INSTANCE_URL,
    };
    detectMock.mockResolvedValue({ linked: repoA, all: [repoA, repoB] } as never);
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-f']));
    const document = {
      ...makeFileDocument('see #1'),
      uri: { scheme: 'file', fsPath: '/ws/repo-b/src/index.ts' },
    };

    const links = await provider.provideDocumentLinks(document as never, {} as never);
    expect(links.length).toBe(1);
    expect((links[0].target as { toString(): string }).toString()).toContain('/repo-b/');
  });
});

describe('getMentionRange', () => {
  function docAt(text: string) {
    return { lineAt: () => ({ text }) };
  }

  it('replaces only the trigger and typed text, not a preceding word (`foo@`)', () => {
    const range = getMentionRange(docAt('foo@') as never, { line: 0, character: 4 } as never) as unknown as {
      args: unknown[];
    };
    expect(range.args).toEqual([0, 3, 0, 4]);
  });

  it('includes the trigger character at line start (`@`)', () => {
    const range = getMentionRange(docAt('@') as never, { line: 0, character: 1 } as never) as unknown as {
      args: unknown[];
    };
    expect(range.args).toEqual([0, 0, 0, 1]);
  });

  it('covers trigger plus partially typed text (`#12`)', () => {
    const range = getMentionRange(docAt('#12') as never, { line: 0, character: 3 } as never) as unknown as {
      args: unknown[];
    };
    expect(range.args).toEqual([0, 0, 0, 3]);
  });
});

describe('email address handling', () => {
  beforeEach(() => {
    detectMock.mockReset();
    detectMock.mockResolvedValue(linkedResult('inst-a') as never);
  });

  it('does not link the domain part of an email address', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-a']));
    const document = makeFileDocument('contact foo@bar.com');
    const links = await provider.provideDocumentLinks(document as never, {} as never);
    expect(links).toEqual([]);
  });

  it('still links a real user mention', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-a']));
    const document = makeFileDocument('thanks @bar');
    const links = await provider.provideDocumentLinks(document as never, {} as never);
    expect(links.length).toBe(1);
  });

  it('offers no `@` completions right after a word character (email context)', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-a']));
    const document = {
      uri: { scheme: 'file' },
      lineAt: () => ({ text: 'foo@' }),
    };
    const items = await provider.provideCompletionItems(
      document as never,
      { line: 0, character: 4 } as never,
      {} as never,
      { triggerCharacter: '@' } as never,
    );
    expect(items).toEqual([]);
  });
});

describe('isMentionTriggerContext', () => {
  it('rejects a line-start `#` not followed by a digit (`#include`, `# comment`)', () => {
    expect(isMentionTriggerContext('#include <stdio.h>', 0, '#')).toBe(false);
    expect(isMentionTriggerContext('  # a comment', 2, '#')).toBe(false);
  });

  it('accepts a line-start `#` followed by a digit (`#123`)', () => {
    expect(isMentionTriggerContext('#123', 0, '#')).toBe(true);
  });

  it('accepts an in-prose `#`', () => {
    expect(isMentionTriggerContext('see #', 4, '#')).toBe(true);
  });

  it('rejects a line-start `@` (decorator / at-rule position)', () => {
    expect(isMentionTriggerContext('@decorator', 0, '@')).toBe(false);
    expect(isMentionTriggerContext('  @media', 2, '@')).toBe(false);
  });

  it('accepts an in-prose `@`', () => {
    expect(isMentionTriggerContext('thanks @', 7, '@')).toBe(true);
  });
});

describe('completion trigger context', () => {
  beforeEach(() => {
    detectMock.mockReset();
    detectMock.mockImplementation(
      (instances: { id: string }[]) => Promise.resolve(linkedResult(instances[0].id)) as never,
    );
  });

  function completionsAt(lineText: string, character: number, trigger: '#' | '@', ids: string[]) {
    const provider = new ForgejoIssueMentionProvider(createConfig(ids));
    const document = {
      uri: { scheme: 'file' },
      lineAt: () => ({ text: lineText }),
    };
    return provider.provideCompletionItems(
      document as never,
      { line: 0, character } as never,
      {} as never,
      { triggerCharacter: trigger } as never,
    );
  }

  it('offers no `#` completions at line start (comment/directive position)', async () => {
    expect(await completionsAt('#', 1, '#', ['inst-g1'])).toEqual([]);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('offers no `@` completions at line start (decorator position)', async () => {
    expect(await completionsAt('  @', 3, '@', ['inst-g2'])).toEqual([]);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('still queries completions for an in-prose `#`', async () => {
    await completionsAt('see #', 5, '#', ['inst-g3']);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });

  it('still queries completions for an in-prose `@`', async () => {
    await completionsAt('hi @', 4, '@', ['inst-g4']);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });
});

describe('completion cache bound', () => {
  it('keeps the cache bounded when the user visits many repositories', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-cache']));
    const internals = provider as unknown as {
      getCachedList: (
        kind: string,
        context: { instanceId: string; owner: string; repo: string },
        fetcher: () => Promise<unknown[]>,
      ) => Promise<unknown[]>;
      mentionCache: Map<string, unknown>;
    };

    for (let index = 0; index < 60; index += 1) {
      await internals.getCachedList(
        'issues',
        { instanceId: 'inst-cache', owner: 'owner', repo: `repo-${index}` },
        async () => [],
      );
    }

    // Lists are only dropped when their key is read again after expiry, so the
    // cache must cap itself instead of growing for the whole session.
    expect(internals.mentionCache.size).toBeLessThanOrEqual(50);
  });
});

describe('document link trigger context', () => {
  beforeEach(() => {
    detectMock.mockReset();
    detectMock.mockResolvedValue(linkedResult('inst-l1') as never);
  });

  it('does not link a line-start `@` token (decorator / at-rule)', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-l1']));
    const document = makeFileDocument('@media screen {\n}\n  @override\n');
    expect(await provider.provideDocumentLinks(document as never, {} as never)).toEqual([]);
  });

  it('does not link a line-start `@user`, but still links it in prose', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-l1']));
    const document = makeFileDocument('@user\nthanks @user');
    const links = await provider.provideDocumentLinks(document as never, {} as never);
    expect(links.length).toBe(1);
  });

  it('still links a line-start `#123`', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-l1']));
    const document = makeFileDocument('#123 fixed this');
    const links = await provider.provideDocumentLinks(document as never, {} as never);
    expect(links.length).toBe(1);
  });

  it('never links `#include` or `# comment` (regex requires digits)', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-l1']));
    const document = makeFileDocument('#include <stdio.h>\n# a comment');
    expect(await provider.provideDocumentLinks(document as never, {} as never)).toEqual([]);
  });
});
