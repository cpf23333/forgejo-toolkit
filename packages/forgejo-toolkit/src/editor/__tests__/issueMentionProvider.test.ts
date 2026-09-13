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
  detectLinkedRepository: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ForgejoIssueMentionProvider, getMentionRange } from '../issueMentionProvider';
import { detectLinkedRepository } from '../../worktree/gitOperations';
import type { ConfigManager } from '../../config';

const INSTANCE_URL = 'https://forgejo.example.com';

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
  return {
    uri: { scheme: 'file' },
    getText: () => text,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  };
}

const detectMock = vi.mocked(detectLinkedRepository);

describe('ForgejoIssueMentionProvider linked repository cache', () => {
  beforeEach(() => {
    detectMock.mockReset();
    detectMock.mockResolvedValue({ instanceId: 'inst-a', owner: 'owner', repo: 'repo' } as never);
  });

  it('probes the git repository only once per instance list within the TTL', async () => {
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-a']));
    const document = makeFileDocument('see #1');

    const first = await provider.provideDocumentLinks(document as never, {} as never);
    const second = await provider.provideDocumentLinks(document as never, {} as never);

    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('caches a negative probe result', async () => {
    detectMock.mockResolvedValue(undefined);
    const provider = new ForgejoIssueMentionProvider(createConfig(['inst-b']));
    const document = makeFileDocument('see #1');

    expect(await provider.provideDocumentLinks(document as never, {} as never)).toEqual([]);
    expect(await provider.provideDocumentLinks(document as never, {} as never)).toEqual([]);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      detectMock.mockResolvedValue({ instanceId: 'inst-c', owner: 'owner', repo: 'repo' } as never);
      const provider = new ForgejoIssueMentionProvider(createConfig(['inst-c']));
      const document = makeFileDocument('see #1');

      await provider.provideDocumentLinks(document as never, {} as never);
      expect(detectMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31_000);
      await provider.provideDocumentLinks(document as never, {} as never);
      expect(detectMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates the cached probe when the instance list changes', async () => {
    detectMock.mockResolvedValue({ instanceId: 'inst-d', owner: 'owner', repo: 'repo' } as never);
    let ids = ['inst-d'];
    const config = {
      getInstances: () => createConfig(ids).getInstances(),
    } as unknown as ConfigManager;
    const provider = new ForgejoIssueMentionProvider(config);
    const document = makeFileDocument('see #1');

    await provider.provideDocumentLinks(document as never, {} as never);
    expect(detectMock).toHaveBeenCalledTimes(1);

    ids = ['inst-d', 'inst-e'];
    await provider.provideDocumentLinks(document as never, {} as never);
    expect(detectMock).toHaveBeenCalledTimes(2);
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
    detectMock.mockResolvedValue({ instanceId: 'inst-a', owner: 'owner', repo: 'repo' } as never);
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
