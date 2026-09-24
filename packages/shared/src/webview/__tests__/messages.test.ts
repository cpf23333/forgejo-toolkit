import { describe, expect, it } from 'vitest';
import { toPublicInstance } from '../messages';
import type { ForgejoInstance, HostToWebviewMessage } from '../messages';

function makeInstance(overrides: Partial<ForgejoInstance> = {}): ForgejoInstance {
  return {
    id: 'instance-1',
    url: 'https://forgejo.example.com',
    token: 'secret-token',
    name: 'Example',
    username: 'demo-user',
    ...overrides,
  };
}

describe('toPublicInstance', () => {
  it('replaces credential userinfo before the URL reaches the webview', () => {
    // The webview is a sandboxed page; a configured instance URL may embed the
    // access token (`https://user:token@host`), so it must never see it.
    const publicInstance = toPublicInstance(
      makeInstance({ url: 'https://demo-user:secret-token@forgejo.example.com' }),
    );

    expect(publicInstance.url).toContain('forgejo.example.com');
    expect(publicInstance.url).not.toContain('secret-token');
    expect(publicInstance.url).toContain('***');
  });

  it('replaces a token written in the username position', () => {
    const publicInstance = toPublicInstance(makeInstance({ url: 'https://secret-token@forgejo.example.com' }));

    expect(publicInstance.url).toBe('https://***@forgejo.example.com/');
  });

  it('leaves a credential-free URL untouched', () => {
    expect(toPublicInstance(makeInstance()).url).toBe('https://forgejo.example.com');
  });

  it('keeps an ssh login visible (it names the account, not a secret)', () => {
    expect(toPublicInstance(makeInstance({ url: 'ssh://git@forgejo.example.com' })).url).toBe(
      'ssh://git@forgejo.example.com',
    );
  });
});

/** The host's answer to a repository file search, as the contract declares it. */
type RepoFilesSearchResult = Extract<HostToWebviewMessage, { command: 'repoFilesSearchResult' }>;

function makeSearchResult(overrides: Partial<RepoFilesSearchResult> = {}): RepoFilesSearchResult {
  return {
    command: 'repoFilesSearchResult',
    instanceId: 'instance-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    ref: 'main',
    query: 'index',
    files: [],
    truncated: true,
    ...overrides,
  };
}

describe('repoFilesSearchResult truncation cause', () => {
  it('lets the host name the cause of a truncated search', () => {
    // `truncated` alone cannot say whether the git tree was unreadable (matches
    // may be missing) or the match list hit its cap (a narrower query returns
    // the rest), and only the second supports that promise, so the cause travels
    // with the flag.
    expect(makeSearchResult({ truncatedBy: 'matches' }).truncatedBy).toBe('matches');
    expect(makeSearchResult({ truncatedBy: 'tree' }).truncatedBy).toBe('tree');
  });

  it('keeps the cause optional for payloads built before the field existed', () => {
    // A host that predates the field sends `truncated` with no cause; the
    // contract must keep accepting that payload, and a consumer that sees no
    // cause must not promise that narrowing recovers the missing matches.
    expect(makeSearchResult().truncatedBy).toBeUndefined();
  });
});
