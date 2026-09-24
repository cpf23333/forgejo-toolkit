import { describe, expect, it } from 'vitest';
import { isSafeRepoNameSegment, isSafeRepoPath } from '../repoIdentity';

/**
 * The webview sends `owner`/`repo`/`path` back to the host, which interpolates
 * them into API routes. Names are restricted to what Forgejo accepts, while a
 * file path keeps its `/` separators and is percent-encoded per segment by the
 * client — so the path guard may only reject what encoding cannot neutralise.
 */
describe('isSafeRepoPath', () => {
  it('accepts ordinary repository-relative paths', () => {
    expect(isSafeRepoPath('src/index.ts')).toBe(true);
    expect(isSafeRepoPath('docs/a b/说明.md')).toBe(true);
    expect(isSafeRepoPath('a.b-c_d')).toBe(true);
    // The repository root is addressed with an empty path.
    expect(isSafeRepoPath('')).toBe(true);
  });

  it('accepts file names containing ? and #, which are legal in a git tree', () => {
    // Each segment is encoded by the client before the route is built, so these
    // can neither end the path nor start a query/fragment. Rejecting them would
    // make such a file impossible to open at all.
    expect(isSafeRepoPath('src/why?.ts')).toBe(true);
    expect(isSafeRepoPath('src/we#ird.md')).toBe(true);
    expect(isSafeRepoPath('notes/what?#now.txt')).toBe(true);
  });

  it('rejects absolute and drive-relative prefixes', () => {
    for (const value of ['/etc/passwd', '\\windows\\system32', 'C:secret', 'c:/windows']) {
      expect(isSafeRepoPath(value), value).toBe(false);
    }
  });

  it('rejects traversal, backslashes and empty segments', () => {
    for (const value of [
      '../../etc/passwd',
      'src/../../x',
      'src//index.ts',
      './src',
      'src/./x',
      'src\\index.ts',
      '..',
      '.',
    ]) {
      expect(isSafeRepoPath(value), value).toBe(false);
    }
  });

  it('rejects control characters, including NUL', () => {
    expect(isSafeRepoPath('src/\u0000evil')).toBe(false);
    expect(isSafeRepoPath('src/ev\nil.ts')).toBe(false);
    expect(isSafeRepoPath('src/ev\u007fil.ts')).toBe(false);
  });

  it('rejects a path longer than the accepted bound', () => {
    expect(isSafeRepoPath(`a/${'b'.repeat(4100)}`)).toBe(false);
  });

  it('still rejects ? and # in an owner/repo name segment', () => {
    // Unlike a path, a name segment is a single route component Forgejo never
    // allows those characters in.
    expect(isSafeRepoNameSegment('repo?state=all')).toBe(false);
    expect(isSafeRepoNameSegment('repo#frag')).toBe(false);
  });
});
