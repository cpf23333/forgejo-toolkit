import { describe, it, expect } from 'vitest';
import { parsePullDiff } from '../parseDiff';

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 changed
+line2.5
 line3
@@ -10,2 +11,3 @@ function foo
 ctxA
+added
 ctxB
\\ No newline at end of file
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-old
+new
`;

describe('parsePullDiff', () => {
  it('returns an empty map for empty input', () => {
    expect(parsePullDiff('').files.size).toBe(0);
  });

  it('maps added, deleted and context lines to file line numbers', () => {
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    const fileMap = files.get('src/a.ts');
    expect(fileMap).toBeDefined();

    // Hunk 1: " line1" is context at base/head line 0.
    expect(fileMap?.baseLines.get(0)).toBe('context');
    expect(fileMap?.headLines.get(0)).toBe('context');
    // "-line2" only exists on the base side (0-based line 1).
    expect(fileMap?.baseLines.get(1)).toBe('deleted');
    expect(fileMap?.headLines.get(1)).toBe('added');
    // "+line2.5" is head line 2.
    expect(fileMap?.headLines.get(2)).toBe('added');
    // " line3" is context at base line 2, head line 3.
    expect(fileMap?.baseLines.get(2)).toBe('context');
    expect(fileMap?.headLines.get(3)).toBe('context');
  });

  it('tracks line numbers across multiple hunks', () => {
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    const fileMap = files.get('src/a.ts');

    // Hunk 2 starts at base line 10 / head line 11 (0-based: 9 / 10).
    expect(fileMap?.baseLines.get(9)).toBe('context');
    expect(fileMap?.headLines.get(10)).toBe('context');
    expect(fileMap?.headLines.get(11)).toBe('added');
    expect(fileMap?.baseLines.get(10)).toBe('context');
    expect(fileMap?.headLines.get(12)).toBe('context');
    // Lines outside the hunks are not part of the diff.
    expect(fileMap?.baseLines.has(3)).toBe(false);
    expect(fileMap?.headLines.has(4)).toBe(false);
  });

  it('ignores the "\\ No newline at end of file" meta line', () => {
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    const fileMap = files.get('src/a.ts');
    // The meta line must not consume a file line: ctxB stays base 10/head 12
    // and no extra entries appear after it.
    expect(fileMap?.baseLines.size).toBe(5);
    expect(fileMap?.headLines.size).toBe(7);
  });

  it('parses multiple files independently', () => {
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    expect(files.size).toBe(2);
    const b = files.get('src/b.ts');
    expect(b?.baseLines.get(0)).toBe('deleted');
    expect(b?.headLines.get(0)).toBe('added');
  });

  it('falls back to the diff --git header when +++ is missing', () => {
    const diff = `diff --git a/src/c.ts b/src/c.ts
@@ -1,1 +1,1 @@
-old
+new
`;
    const { files } = parsePullDiff(diff);
    expect(files.get('src/c.ts')?.headLines.get(0)).toBe('added');
  });

  it('treats empty lines inside a hunk as context', () => {
    const diff = `diff --git a/src/d.ts b/src/d.ts
--- a/src/d.ts
+++ b/src/d.ts
@@ -1,2 +1,2 @@

 line
`;
    const { files } = parsePullDiff(diff);
    const fileMap = files.get('src/d.ts');
    expect(fileMap?.baseLines.get(0)).toBe('context');
    expect(fileMap?.headLines.get(0)).toBe('context');
  });
});
