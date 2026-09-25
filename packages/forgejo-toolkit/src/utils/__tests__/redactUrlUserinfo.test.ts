import { describe, expect, it } from 'vitest';
import { hasUrlUserinfo, redactUrlUserinfo, redactUserinfoInText, stripUrlUserinfo } from '../redactUrlUserinfo';

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

/**
 * The other half of the rule: masking is only ever right for a value a human
 * reads. A URL the extension or git then *uses* must carry no userinfo at all,
 * because `***` is not a credential and Node's `fetch` refuses a URL with
 * credentials outright.
 */
describe('stripUrlUserinfo', () => {
  it('removes a password and its username', () => {
    expect(stripUrlUserinfo('https://alice:s3cret@forgejo.example.com/alice/repo.git')).toBe(
      'https://forgejo.example.com/alice/repo.git',
    );
  });

  it('removes a token written in the username position', () => {
    expect(stripUrlUserinfo('https://s3cret@forgejo.example.com/api/v1/user')).toBe(
      'https://forgejo.example.com/api/v1/user',
    );
  });

  it('never leaves the redaction marker behind', () => {
    expect(stripUrlUserinfo('https://alice:s3cret@forgejo.example.com')).not.toContain('***');
  });

  it('keeps a port, a sub-path and a query', () => {
    expect(stripUrlUserinfo('https://alice:pw@forgejo.example.com:3000/git/api/v1/user?page=1')).toBe(
      'https://forgejo.example.com:3000/git/api/v1/user?page=1',
    );
  });

  it('still strips a password on a non-http scheme', () => {
    expect(stripUrlUserinfo('ssh://git:pw@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://forgejo.example.com/owner/repo.git',
    );
  });

  it('leaves credential-free URLs byte-for-byte unchanged', () => {
    // No userinfo means no re-serialization, so a caller's URL is never
    // respelled (nor given a trailing slash) by this helper.
    expect(stripUrlUserinfo('https://forgejo.example.com')).toBe('https://forgejo.example.com');
    expect(stripUrlUserinfo('https://forgejo.example.com/owner/repo.git')).toBe(
      'https://forgejo.example.com/owner/repo.git',
    );
    expect(stripUrlUserinfo('git@forgejo.example.com:alice/repo.git')).toBe('git@forgejo.example.com:alice/repo.git');
    expect(stripUrlUserinfo('D:\\repos\\my repo')).toBe('D:\\repos\\my repo');
  });

  it('also drops a plain ssh login, which is userinfo the URL does not need', () => {
    // `redactUrlUserinfo` deliberately keeps `ssh://git@host` readable, because
    // it names no secret. This helper has a different job — hand a URL to a
    // consumer — and git supplies the ssh login itself, so the userinfo goes.
    expect(stripUrlUserinfo('ssh://git@forgejo.example.com/owner/repo.git')).toBe(
      'ssh://forgejo.example.com/owner/repo.git',
    );
  });
});

describe('hasUrlUserinfo', () => {
  it('detects a credential in either position of an http(s) URL', () => {
    expect(hasUrlUserinfo('https://alice:s3cret@forgejo.example.com')).toBe(true);
    expect(hasUrlUserinfo('https://s3cret@forgejo.example.com/api/v1/user')).toBe(true);
    expect(hasUrlUserinfo('http://alice:s3cret@forgejo.example.com')).toBe(true);
  });

  it('is false for an http(s) URL without userinfo', () => {
    expect(hasUrlUserinfo('https://forgejo.example.com')).toBe(false);
    expect(hasUrlUserinfo('https://forgejo.example.com:3000/git')).toBe(false);
    // An `@` in the path is not userinfo.
    expect(hasUrlUserinfo('https://forgejo.example.com/owner@example/repo')).toBe(false);
  });

  it('is false for an ssh login, which names no secret, and for non-http schemes', () => {
    // The storage boundary only ever stores http(s), and an ssh login is not a
    // credential this check exists for.
    expect(hasUrlUserinfo('ssh://git@forgejo.example.com/owner/repo.git')).toBe(false);
    expect(hasUrlUserinfo('ssh://alice:pw@forgejo.example.com/owner/repo.git')).toBe(false);
  });

  it('is false for an unparseable value instead of throwing', () => {
    expect(hasUrlUserinfo('git@forgejo.example.com:alice/repo.git')).toBe(false);
    expect(hasUrlUserinfo('forgejo.example.com')).toBe(false);
    expect(hasUrlUserinfo('')).toBe(false);
  });
});

/**
 * The same masking rule applied to prose rather than to a value that is wholly
 * a URL: git's stderr quotes the remote it failed against, and the user's own
 * remote configuration may have given that URL credentials.
 */
describe('redactUserinfoInText', () => {
  it('masks the credentials of a URL quoted inside a git error message', () => {
    expect(
      redactUserinfoInText(
        "fatal: unable to access 'https://alice:s3cret@forgejo.example.com/owner/repo.git/': The requested URL returned error: 403",
      ),
    ).toBe(
      "fatal: unable to access 'https://alice:***@forgejo.example.com/owner/repo.git/': The requested URL returned error: 403",
    );
  });

  it('masks a token written in the username position, wherever it appears', () => {
    expect(
      redactUserinfoInText("fatal: Authentication failed for 'https://s3cret@forgejo.example.com/owner/repo.git/'"),
    ).toBe("fatal: Authentication failed for 'https://***@forgejo.example.com/owner/repo.git/'");
  });

  it('leaves credential-free messages untouched', () => {
    expect(redactUserinfoInText("fatal: repository 'https://forgejo.example.com/owner/repo.git/' not found")).toBe(
      "fatal: repository 'https://forgejo.example.com/owner/repo.git/' not found",
    );
    expect(redactUserinfoInText('fatal: refusing to fetch into branch')).toBe('fatal: refusing to fetch into branch');
  });
});
