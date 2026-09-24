import { describe, expect, it } from 'vitest';
import { redactUrlUserinfo } from '../redactUrlUserinfo';

/**
 * The single implementation of "remove credentials from a URL before logging
 * it". Three call sites depend on it — the API client's request/response debug
 * lines, the server-version probe, and the git remote logging — so the rule is
 * stated once here.
 */
describe('redactUrlUserinfo', () => {
  it('blanks the password and keeps the http username recognisable', () => {
    expect(redactUrlUserinfo('https://alice:s3cret@forgejo.example.com/alice/repo.git')).toBe(
      'https://alice:***@forgejo.example.com/alice/repo.git',
    );
  });

  it('blanks a username that is the only userinfo of an http(s) URL', () => {
    // A Forgejo access token is commonly written in the username position:
    // `https://<token>@host`.
    expect(redactUrlUserinfo('https://token@forgejo.example.com/api/v1/user')).toBe(
      'https://***@forgejo.example.com/api/v1/user',
    );
    expect(redactUrlUserinfo('https://token@forgejo.example.com')).toBe('https://***@forgejo.example.com/');
  });

  it('keeps a plain ssh user visible, because it names no secret', () => {
    expect(redactUrlUserinfo('ssh://git@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://git@forgejo.example.com/owner/repo.git',
    );
    expect(redactUrlUserinfo('git+ssh://git@forgejo.example.com:2222/owner/repo.git')).toBe(
      'git+ssh://git@forgejo.example.com:2222/owner/repo.git',
    );
  });

  it('still blanks a password on an ssh URL', () => {
    expect(redactUrlUserinfo('ssh://git:pw@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://git:***@forgejo.example.com/owner/repo.git',
    );
  });

  it('leaves credential-free URLs untouched', () => {
    expect(redactUrlUserinfo('https://forgejo.example.com/alice/repo.git')).toBe(
      'https://forgejo.example.com/alice/repo.git',
    );
    expect(redactUrlUserinfo('https://forgejo.example.com:3000/api/v1/user?page=1')).toBe(
      'https://forgejo.example.com:3000/api/v1/user?page=1',
    );
  });

  it('leaves scp-style remotes and local paths untouched without parsing them', () => {
    expect(redactUrlUserinfo('git@forgejo.example.com:alice/repo.git')).toBe('git@forgejo.example.com:alice/repo.git');
    expect(redactUrlUserinfo('D:\\repos\\my repo')).toBe('D:\\repos\\my repo');
    expect(redactUrlUserinfo('forgejo.example.com')).toBe('forgejo.example.com');
  });
});
