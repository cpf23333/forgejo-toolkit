export type DiffLineType = 'context' | 'deleted' | 'added';

export interface FileDiffMap {
  /** 0-based line number in the base (left) file -> diff line type. */
  baseLines: Map<number, DiffLineType>;
  /** 0-based line number in the head (right) file -> diff line type. */
  headLines: Map<number, DiffLineType>;
}

export interface ParsedPullDiff {
  /** file path -> diff map. */
  files: Map<string, FileDiffMap>;
}

/**
 * Parse a unified diff for a pull request.
 *
 * Forgejo review comment positions are 1-based file line numbers (not
 * GitHub-style diff positions), so this map only records which file lines
 * are part of the diff and whether each line is added, deleted, or context.
 * It is used when creating comments to decide which side (base/head) a line
 * can be commented on; rendering resolves comment positions directly
 * against the opened document.
 */
export function parsePullDiff(diffText: string): ParsedPullDiff {
  const files = new Map<string, FileDiffMap>();
  if (!diffText) {
    return { files };
  }

  const fileBlocks = splitDiffIntoFileBlocks(diffText);
  for (const block of fileBlocks) {
    const path = extractFilePath(block);
    if (!path) {
      continue;
    }
    const map = parseFileDiff(block);
    if (map.baseLines.size > 0 || map.headLines.size > 0) {
      files.set(path, map);
    }
  }

  return { files };
}

function splitDiffIntoFileBlocks(diffText: string): string[] {
  const lines = diffText.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
}

// Trailing TAB git puts after the path on a `+++`/`---` line when the name
// contains a space (the line is otherwise TAB-terminated for a name without one,
// and an empty trailing field is insignificant). The TAB is a field separator,
// not part of the name.
const PATH_TRAILING_TAB_RE = /\t+$/;

// git C-quotes a path (`core.quotePath=true`, the default) when it contains a
// byte above 0x7f, a double quote, a backslash, or a control character, and
// escapes it as `"b/..."`. Non-ASCII UTF-8 bytes are written as octal escapes
// of the *bytes* (`\344\270\255`), not of a code point, so the escapes are
// collected as bytes and decoded together.
const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/** Undo git's C-quoting (including the surrounding double quotes). */
function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  const bytes: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      break;
    }
    if (char !== '\\') {
      // Characters outside an escape are written literally; for a quoted name
      // they are plain ASCII, so a char code is its byte.
      bytes.push(value.charCodeAt(index));
      continue;
    }
    const octalMatch = /^[0-7]{1,3}/.exec(value.slice(index + 1));
    if (octalMatch) {
      bytes.push(Number.parseInt(octalMatch[0], 8));
      index += octalMatch[0].length;
      continue;
    }
    index += 1;
    // An unknown escape stands for the character itself (git only emits the
    // escapes C defines, but a hand-written diff may carry anything).
    bytes.push(SIMPLE_ESCAPES[value[index]] ?? value.charCodeAt(index));
  }
  // The collected bytes are UTF-8, so decode them instead of mapping each byte
  // to a character (that would mangle every non-ASCII name).
  return Buffer.from(bytes).toString('utf8');
}

function stripDiffPathField(field: string): string {
  const withoutTab = field.replace(PATH_TRAILING_TAB_RE, '');
  return decodeGitQuotedPath(withoutTab);
}

function extractFilePath(block: string): string | undefined {
  // Prefer the "+++ b/path" line for the destination path. The `b/` prefix is
  // stripped after unquoting, because git puts it *inside* the quotes of a
  // C-quoted name (`+++ "b/\346\226\207.txt"`), where a pattern anchored on a
  // literal `b/` cannot see it.
  const plusMatch = block.match(/^\+\+\+ (.*)$/m);
  if (plusMatch) {
    const path = stripDiffPathField(plusMatch[1]);
    const withoutPrefix = path.startsWith('b/') ? path.slice(2) : path;
    if (withoutPrefix && withoutPrefix !== '/dev/null') {
      return withoutPrefix;
    }
  }
  // Fall back to the diff --git line: a quoted form (which can contain spaces)
  // first, then the plain form for a name without one.
  const quotedGitMatch = block.match(/^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/m);
  if (quotedGitMatch) {
    const path = stripDiffPathField(quotedGitMatch[2]);
    return path.startsWith('b/') ? path.slice(2) : path;
  }
  const gitMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
  if (gitMatch) {
    return gitMatch[2];
  }
  return undefined;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseFileDiff(block: string): FileDiffMap {
  const baseLines = new Map<number, DiffLineType>();
  const headLines = new Map<number, DiffLineType>();

  const lines = block.split(/\r?\n/);
  // git always terminates the diff with a newline, so the final block carries
  // one trailing empty element. Counting it as a context line would map a line
  // one past the last hunk line (a comment there is rejected by the server);
  // only that final element is dropped, so genuinely empty lines inside a hunk
  // stay context lines.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  let baseLine = 0;
  let headLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    if (!inHunk) {
      const hunkMatch = rawLine.match(HUNK_HEADER_RE);
      if (hunkMatch) {
        inHunk = true;
        baseLine = Number(hunkMatch[1]) - 1;
        headLine = Number(hunkMatch[3]) - 1;
      }
      continue;
    }

    const nextHunkMatch = rawLine.match(HUNK_HEADER_RE);
    if (nextHunkMatch) {
      baseLine = Number(nextHunkMatch[1]) - 1;
      headLine = Number(nextHunkMatch[3]) - 1;
      continue;
    }

    if (rawLine.length === 0) {
      // Empty line inside a hunk is treated as context.
      baseLines.set(baseLine, 'context');
      headLines.set(headLine, 'context');
      baseLine += 1;
      headLine += 1;
      continue;
    }

    const marker = rawLine.charAt(0);
    if (marker === '+') {
      headLines.set(headLine, 'added');
      headLine += 1;
    } else if (marker === '-') {
      baseLines.set(baseLine, 'deleted');
      baseLine += 1;
    } else if (marker === ' ' || marker === '\t') {
      baseLines.set(baseLine, 'context');
      headLines.set(headLine, 'context');
      baseLine += 1;
      headLine += 1;
    } else if (rawLine.startsWith('\\ No newline at end of file')) {
      // This meta line does not occupy a file line.
      continue;
    } else {
      // Anything outside a hunk ends parsing for this file.
      break;
    }
  }

  return { baseLines, headLines };
}
