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

/**
 * The display `url` is unusable for anything functional: it keeps `***` where the
 * credential was, so a clone URL built from it is not one git can clone and an
 * "open in browser" link built from it is dead. The public shape therefore
 * carries the same URL with the userinfo *removed*, and every path the webview
 * navigates to or copies reads that field.
 */
describe('toPublicInstance functional URL', () => {
  it('drops both credential positions instead of masking them', () => {
    const withPassword = toPublicInstance(
      makeInstance({ url: 'https://demo-user:secret-token@forgejo.example.com/base' }),
    );
    const withToken = toPublicInstance(makeInstance({ url: 'https://secret-token@forgejo.example.com' }));

    expect(withPassword.functionalUrl).toBe('https://forgejo.example.com/base');
    expect(withToken.functionalUrl).toBe('https://forgejo.example.com/');
  });

  it('never carries userinfo, in either direction', () => {
    // Whatever the credential was, `@` before the host is what made the URL
    // unusable — so the guarantee is the absence of userinfo, not the absence of
    // one particular spelling of the secret.
    for (const url of [
      'https://demo-user:secret-token@forgejo.example.com',
      'https://secret-token@forgejo.example.com',
      'https://demo-user@forgejo.example.com/base',
    ]) {
      const functionalUrl = toPublicInstance(makeInstance({ url })).functionalUrl;
      expect(functionalUrl).not.toContain('secret-token');
      expect(functionalUrl).not.toContain('***');
      expect(new URL(functionalUrl).username).toBe('');
      expect(new URL(functionalUrl).password).toBe('');
    }
  });

  it('leaves a credential-free URL untouched', () => {
    // The ordinary case must not be rewritten: no added trailing slash, no
    // re-encoded path.
    expect(toPublicInstance(makeInstance()).functionalUrl).toBe('https://forgejo.example.com');
    expect(toPublicInstance(makeInstance({ url: 'https://forgejo.example.com:3000/base' })).functionalUrl).toBe(
      'https://forgejo.example.com:3000/base',
    );
  });

  it('keeps the display value masked while the functional one is plain', () => {
    const publicInstance = toPublicInstance(makeInstance({ url: 'https://secret-token@forgejo.example.com' }));

    expect(publicInstance.url).toBe('https://***@forgejo.example.com/');
    expect(publicInstance.functionalUrl).toBe('https://forgejo.example.com/');
    expect(publicInstance.functionalUrl).not.toBe(publicInstance.url);
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

  it('keeps `truncated` and its cause independent', () => {
    // `truncated` is cause-neutral: a capped match list over a fully read tree
    // (`'matches'`) is as truncated as an unreadable tree (`'tree'`), so the flag
    // must not be read as "the repository was not fully searched".
    expect(makeSearchResult({ truncated: true, truncatedBy: 'matches' }).truncated).toBe(true);
    expect(makeSearchResult({ truncated: true, truncatedBy: 'tree' }).truncated).toBe(true);
  });
});

/** The host's answer to a pull-request detail request, as the contract declares it. */
type PullRequestDetailReply = Extract<HostToWebviewMessage, { command: 'pullRequestDetail' }>;

function makePullRequestDetailReply(overrides: Partial<PullRequestDetailReply> = {}): PullRequestDetailReply {
  return {
    command: 'pullRequestDetail',
    instanceId: 'instance-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 1,
    detail: {},
    ...overrides,
  };
}

describe('pullRequestDetail attachments probe', () => {
  it('stays valid when the host sends no attachments flag', () => {
    // A successful probe (or a payload from a host build that predates the flag)
    // leaves the field absent, which is what the webview reads as "the empty
    // assets list really means no attachments".
    expect(makePullRequestDetailReply().attachmentsUnavailable).toBeUndefined();
  });

  it('type-checks the only-when-true flag the host sends beside a failed probe', () => {
    // viewProvider sends `attachmentsUnavailable: true` (and nothing otherwise)
    // when the attachments probe failed; before this was declared the host had to
    // work around the contract with a local type.
    expect(makePullRequestDetailReply({ attachmentsUnavailable: true }).attachmentsUnavailable).toBe(true);
  });
});

/** The host's answer to an import-preview request, as the contract declares it. */
type ImportPreviewReply = Extract<HostToWebviewMessage, { command: 'importInstancesPreview' }>;

function makeImportPreviewReply(overrides: Partial<ImportPreviewReply> = {}): ImportPreviewReply {
  return {
    command: 'importInstancesPreview',
    instances: [],
    existingIds: [],
    ...overrides,
  };
}

describe('importInstancesPreview dropped count', () => {
  it('stays valid when nothing was dropped', () => {
    // Absent is the "nothing to warn about" shape: a clean import file and a host
    // build that predates the count both send no `dropped`.
    expect(makeImportPreviewReply().dropped).toBeUndefined();
  });

  it('type-checks the count the host sends only when entries were skipped', () => {
    expect(makeImportPreviewReply({ dropped: 2 }).dropped).toBe(2);
  });
});

describe('importInstancesPreview token exclusion', () => {
  it('type-checks preview entries that carry no token field', () => {
    // The preview renders non-secret fields only: the token is stashed
    // host-side and rehydrated by id on confirm, so the wire entry has no
    // token property at all.
    const reply = makeImportPreviewReply({
      instances: [{ id: 'instance-1', url: 'https://forgejo.example.com', name: 'Example', username: 'demo-user' }],
    });

    expect(reply.instances).toHaveLength(1);
  });

  it('rejects an entry that still carries a token', () => {
    // `token?: never` turns what used to be a sender-side convention (the host
    // blanks the token by hand) into a compile-time exclusion: a payload that
    // still carries one must not type-check.
    // @ts-expect-error -- the preview payload must never carry a token
    const reply = makeImportPreviewReply({ instances: [makeInstance()] });

    expect(reply.instances[0]?.id).toBe('instance-1');
  });
});

/**
 * The reply fields the host sends that no consumer reads yet. They stay in the
 * contract because the extension host sends them (removing one would break the
 * sender), and each carries a doc comment saying what a consumer must do when it
 * starts reading it — see the field docs in `messages.ts`.
 */
describe('reply fields the host sends before a consumer reads them', () => {
  type ArtifactDownloadedReply = Extract<HostToWebviewMessage, { command: 'actionArtifactDownloaded' }>;
  type WorktreeOpenedReply = Extract<HostToWebviewMessage, { command: 'worktreeOpened' }>;
  type DependencyChangedReply = Extract<HostToWebviewMessage, { command: 'issueDependencyChanged' }>;
  type RunDispatchedReply = Extract<HostToWebviewMessage, { command: 'actionRunDispatched' }>;

  it('keeps the artifact-download cancel distinct from a failure and from a success', () => {
    // The host answers a declined save dialog with `{ cancelled: true }` and no
    // `error` (viewProvider), which is why a consumer that only branches on
    // `error` would take the success branch and clear a stale error.
    const cancelled: ArtifactDownloadedReply = {
      command: 'actionArtifactDownloaded',
      instanceId: 'instance-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      artifactId: 7,
      cancelled: true,
    };
    const saved: ArtifactDownloadedReply = { ...cancelled, cancelled: undefined, path: 'artifact.zip' };

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.error).toBeUndefined();
    expect(cancelled.path).toBeUndefined();
    expect(saved.path).toBe('artifact.zip');
  });

  it('keeps the worktreeOpened existence flag in the wire shape', () => {
    const reused: WorktreeOpenedReply = { command: 'worktreeOpened', worktree: {}, existed: true };
    const created: WorktreeOpenedReply = { command: 'worktreeOpened', worktree: {}, existed: false };

    expect(reused.existed).toBe(true);
    expect(created.existed).toBe(false);
  });

  it('keeps the issue-dependency echo fields in the wire shape', () => {
    const reply: DependencyChangedReply = {
      command: 'issueDependencyChanged',
      instanceId: 'instance-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 5,
      dependencyIndex: 6,
      action: 'remove',
    };

    expect(reply.dependencyIndex).toBe(6);
    expect(reply.action).toBe('remove');
  });

  it('keeps the dispatch acceptance flag in the wire shape', () => {
    const reply: RunDispatchedReply = {
      command: 'actionRunDispatched',
      instanceId: 'instance-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      workflowfilename: 'ci.yml',
      accepted: true,
    };

    expect(reply.accepted).toBe(true);
  });
});
