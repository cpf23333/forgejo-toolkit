import { describe, expect, it } from 'vitest';
import { encodePermalinkPath } from '../permalink';

describe('encodePermalinkPath', () => {
  it('leaves a plain path unchanged', () => {
    expect(encodePermalinkPath('src/index.ts')).toBe('src/index.ts');
  });

  it('keeps `/` separators while encoding each segment', () => {
    expect(encodePermalinkPath('my dir/my file.txt')).toBe('my%20dir/my%20file.txt');
  });

  it('encodes `#` so it cannot truncate the URL before the line fragment', () => {
    expect(encodePermalinkPath('a#b.txt')).toBe('a%23b.txt');
  });

  it('encodes `?` and `%`', () => {
    expect(encodePermalinkPath('what?.txt')).toBe('what%3F.txt');
    expect(encodePermalinkPath('100%.txt')).toBe('100%25.txt');
  });

  it('encodes non-ASCII file names per segment', () => {
    expect(encodePermalinkPath('文档/说明.md')).toBe(`${encodeURIComponent('文档')}/${encodeURIComponent('说明')}.md`);
  });

  it('produces a valid URL when combined with a line-range fragment', () => {
    const url = `https://forgejo.example.com/owner/repo/blob/main/${encodePermalinkPath('dir/a#b.txt')}#L3`;
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/owner/repo/blob/main/dir/a%23b.txt');
    expect(parsed.hash).toBe('#L3');
  });
});
