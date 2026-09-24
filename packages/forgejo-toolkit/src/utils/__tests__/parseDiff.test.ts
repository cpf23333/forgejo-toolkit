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

  it('does not fabricate a trailing context line for the last file', () => {
    // git always terminates the diff with a newline; the resulting trailing
    // empty element must not become a context entry one line past the last
    // hunk line (a comment on it is rejected by the server).
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    const last = files.get('src/b.ts');
    expect(last?.baseLines.get(0)).toBe('deleted');
    expect(last?.headLines.get(0)).toBe('added');
    expect(last?.baseLines.size).toBe(1);
    expect(last?.headLines.size).toBe(1);
    expect(last?.baseLines.has(1)).toBe(false);
    expect(last?.headLines.has(1)).toBe(false);
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
    // The genuine empty line inside the hunk is kept as context; the diff's
    // trailing newline does not add a third entry past it.
    expect(fileMap?.baseLines.size).toBe(2);
    expect(fileMap?.headLines.size).toBe(2);
  });
});

/**
 * The comment controller looks a file up by the API filename, so this map's keys
 * must be the real repository paths: git's own encoding of a name — a trailing
 * TAB after a name containing a space, or a C-quoted name for non-ASCII bytes —
 * would never match and the file would be silently skipped.
 */
describe('parsePullDiff file paths', () => {
  it('decodes a path containing a space and a trailing TAB', () => {
    const diff = `diff --git a/with space.txt b/with space.txt
index 1111111..2222222 100644
--- a/with space.txt\t
+++ b/with space.txt\t
@@ -1,1 +1,1 @@
-old
+new
`;
    const { files } = parsePullDiff(diff);
    // git TAB-terminates the +++/--- field for a spaced name; the TAB is a
    // separator, not part of the path.
    expect([...files.keys()]).toEqual(['with space.txt']);
    expect(files.get('with space.txt')?.headLines.get(0)).toBe('added');
  });

  it('decodes git C-quoted non-ASCII path bytes', () => {
    // core.quotePath=true is git's default, so a UTF-8 name arrives quoted with
    // octal escapes of its bytes: \346\226\207\344\273\266 = 文件.
    const diff = `diff --git "a/\\346\\226\\207\\344\\273\\266.txt" "b/\\346\\226\\207\\344\\273\\266.txt"
index 1111111..2222222 100644
--- "a/\\346\\226\\207\\344\\273\\266.txt"
+++ "b/\\346\\226\\207\\344\\273\\266.txt"
@@ -1,1 +1,1 @@
-old
+new
`;
    const { files } = parsePullDiff(diff);
    expect([...files.keys()]).toEqual(['文件.txt']);
    expect(files.get('文件.txt')?.headLines.get(0)).toBe('added');
  });

  it('decodes a C-quoted name that also contains a space', () => {
    const diff = `diff --git "a/my \\346\\226\\207.txt" "b/my \\346\\226\\207.txt"
--- "a/my \\346\\226\\207.txt"
+++ "b/my \\346\\226\\207.txt"
@@ -1,1 +1,1 @@
-old
+new
`;
    const { files } = parsePullDiff(diff);
    expect([...files.keys()]).toEqual(['my 文.txt']);
  });

  it('keeps a plain path unchanged', () => {
    const { files } = parsePullDiff(MULTI_FILE_DIFF);
    expect([...files.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('decodes a quoted path from the diff --git fallback when +++ is missing', () => {
    const diff = `diff --git "a/\\346\\226\\207.txt" "b/\\346\\226\\207.txt"
@@ -1,1 +1,1 @@
-old
+new
`;
    const { files } = parsePullDiff(diff);
    expect([...files.keys()]).toEqual(['文.txt']);
  });

  it('falls back to the diff --git line for the path of an added file', () => {
    // An added file has /dev/null on the --- side; the +++ side names it.
    const diff = `diff --git a/new file.txt b/new file.txt
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/new file.txt\t
@@ -0,0 +1,1 @@
+new
`;
    const { files } = parsePullDiff(diff);
    expect([...files.keys()]).toEqual(['new file.txt']);
  });
});
