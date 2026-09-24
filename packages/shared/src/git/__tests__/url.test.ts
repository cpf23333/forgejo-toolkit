import { describe, expect, it } from 'vitest';
import { isSshOrGitRemote, normalizeGitRemote, normalizeGitUrl } from '../url';

describe('normalizeGitUrl', () => {
  it('removes .git suffix and trailing slashes', () => {
    expect(normalizeGitUrl('https://codeberg.org/owner/repo.git')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/owner/repo.git/')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/owner/repo/')).toBe('https://codeberg.org/owner/repo');
  });

  it('lowercases the url', () => {
    expect(normalizeGitUrl('https://Codeberg.org/Owner/Repo')).toBe('https://codeberg.org/owner/repo');
  });

  it('removes an upper- or mixed-case .git suffix', () => {
    // The suffix check used to be case-sensitive while the rest of the function
    // lowercased, so `.GIT` survived and produced the repo name `repo.git` —
    // which 404s against the API and never matches another spelling of the same
    // remote in sameRepositoryUrl or a revert target.
    expect(normalizeGitUrl('https://codeberg.org/Owner/Repo.GIT')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/Owner/Repo.Git')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/Owner/Repo.GIT/')).toBe('https://codeberg.org/owner/repo');
  });

  it('leaves a repository name without a .git suffix untouched', () => {
    expect(normalizeGitUrl('https://codeberg.org/owner/repo')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://Codeberg.org/Owner/Repo/')).toBe('https://codeberg.org/owner/repo');
  });
});

describe('normalizeGitRemote', () => {
  it('parses https remotes', () => {
    const result = normalizeGitRemote('https://codeberg.org/owner/repo.git');
    expect(result).toEqual({
      normalized: 'codeberg.org/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses ssh remotes', () => {
    const result = normalizeGitRemote('git@codeberg.org:owner/repo.git');
    expect(result).toEqual({
      normalized: 'codeberg.org/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('handles ports in https remotes', () => {
    const result = normalizeGitRemote('https://forgejo.example.com:3004/owner/repo.git');
    expect(result).toEqual({
      normalized: 'forgejo.example.com:3004/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('drops the default https port', () => {
    const result = normalizeGitRemote('https://forgejo.example.com:443/owner/repo.git');
    expect(result).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('strips the port from ssh:// remotes', () => {
    const result = normalizeGitRemote('ssh://git@forgejo.example.com:2222/owner/repo.git');
    expect(result).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses ssh:// remotes without a port', () => {
    const result = normalizeGitRemote('ssh://git@forgejo.example.com/owner/repo.git');
    expect(result).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('strips the port from git:// remotes', () => {
    const result = normalizeGitRemote('git://forgejo.example.com:9418/owner/repo.git');
    expect(result).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns undefined for invalid urls', () => {
    expect(normalizeGitRemote('not-a-url')).toBeUndefined();
  });

  it('reports the repository name of an uppercase .GIT remote without the suffix', () => {
    const result = normalizeGitRemote('https://forgejo.example.com/owner/repo.GIT');
    expect(result).toEqual({
      normalized: 'forgejo.example.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns undefined for urls without owner/repo', () => {
    expect(normalizeGitRemote('https://codeberg.org/')).toBeUndefined();
    expect(normalizeGitRemote('https://codeberg.org/owner')).toBeUndefined();
  });
});

describe('isSshOrGitRemote', () => {
  it('detects ssh://, git:// and scp-style remotes', () => {
    expect(isSshOrGitRemote('ssh://git@forgejo.example.com:2222/owner/repo.git')).toBe(true);
    expect(isSshOrGitRemote('git://forgejo.example.com:9418/owner/repo.git')).toBe(true);
    expect(isSshOrGitRemote('git@forgejo.example.com:owner/repo.git')).toBe(true);
  });

  it('rejects http(s) remotes and invalid urls', () => {
    expect(isSshOrGitRemote('https://forgejo.example.com/owner/repo.git')).toBe(false);
    expect(isSshOrGitRemote('http://forgejo.example.com:3000/owner/repo.git')).toBe(false);
    expect(isSshOrGitRemote('not-a-url')).toBe(false);
  });
});
