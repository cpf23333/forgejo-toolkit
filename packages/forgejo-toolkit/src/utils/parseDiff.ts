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

function extractFilePath(block: string): string | undefined {
  // Prefer the "+++ b/path" line for the destination path.
  const plusMatch = block.match(/^\+\+\+ b\/(.+)$/m);
  if (plusMatch) {
    return plusMatch[1];
  }
  // Fall back to the diff --git line.
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
