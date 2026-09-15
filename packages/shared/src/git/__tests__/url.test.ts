import { describe, expect, it } from 'vitest';
import { normalizeGitRemote, normalizeGitUrl } from '../url';

describe('normalizeGitUrl', () => {
  it('removes .git suffix and trailing slashes', () => {
    expect(normalizeGitUrl('https://codeberg.org/owner/repo.git')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/owner/repo.git/')).toBe('https://codeberg.org/owner/repo');
    expect(normalizeGitUrl('https://codeberg.org/owner/repo/')).toBe('https://codeberg.org/owner/repo');
  });

  it('lowercases the url', () => {
    expect(normalizeGitUrl('https://Codeberg.org/Owner/Repo')).toBe('https://codeberg.org/owner/repo');
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

  it('returns undefined for urls without owner/repo', () => {
    expect(normalizeGitRemote('https://codeberg.org/')).toBeUndefined();
    expect(normalizeGitRemote('https://codeberg.org/owner')).toBeUndefined();
  });
});
