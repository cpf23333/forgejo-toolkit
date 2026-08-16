export type DiffLineType = 'header' | 'context' | 'deleted' | 'added';

export interface DiffPositionInfo {
  /** Type of the diff line at this position. */
  type: DiffLineType;
  /** 0-based line number in the base (left) side, if applicable. */
  baseLine?: number;
  /** 0-based line number in the head (right) side, if applicable. */
  headLine?: number;
  /** Raw content of the diff line (without the leading +/- prefix). */
  content: string;
}

export interface FileDiffMap {
  /** position (1-based within the file's diff) -> line info. */
  positions: Map<number, DiffPositionInfo>;
  /** base line (0-based) -> positions that map to it. */
  baseLineToPositions: Map<number, number[]>;
  /** head line (0-based) -> positions that map to it. */
  headLineToPositions: Map<number, number[]>;
}

export interface ParsedPullDiff {
  /** file path -> diff map. */
  files: Map<string, FileDiffMap>;
}

/**
 * Parse a unified diff for a pull request.
 *
 * Forgejo's review comment `position` is the 1-based index of a line within
 * the file's diff, starting from the first hunk header (`@@`). Hunk headers
 * themselves occupy a position.
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
    if (map.positions.size > 0) {
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
  const positions = new Map<number, DiffPositionInfo>();
  const baseLineToPositions = new Map<number, number[]>();
  const headLineToPositions = new Map<number, number[]>();

  const lines = block.split(/\r?\n/);
  let position = 0;
  let baseLine = 0;
  let headLine = 0;
  let inHunk = false;

  function record(info: DiffPositionInfo) {
    position += 1;
    positions.set(position, info);
    if (info.baseLine !== undefined) {
      const list = baseLineToPositions.get(info.baseLine) ?? [];
      list.push(position);
      baseLineToPositions.set(info.baseLine, list);
    }
    if (info.headLine !== undefined) {
      const list = headLineToPositions.get(info.headLine) ?? [];
      list.push(position);
      headLineToPositions.set(info.headLine, list);
    }
  }

  for (const rawLine of lines) {
    if (!inHunk) {
      const hunkMatch = rawLine.match(HUNK_HEADER_RE);
      if (hunkMatch) {
        inHunk = true;
        baseLine = Number(hunkMatch[1]) - 1;
        headLine = Number(hunkMatch[3]) - 1;
        record({ type: 'header', content: rawLine });
      }
      continue;
    }

    const nextHunkMatch = rawLine.match(HUNK_HEADER_RE);
    if (nextHunkMatch) {
      baseLine = Number(nextHunkMatch[1]) - 1;
      headLine = Number(nextHunkMatch[3]) - 1;
      record({ type: 'header', content: rawLine });
      continue;
    }

    if (rawLine.length === 0) {
      // Empty line inside a hunk is treated as context.
      baseLine += 1;
      headLine += 1;
      record({ type: 'context', baseLine: baseLine - 1, headLine: headLine - 1, content: rawLine });
      continue;
    }

    const marker = rawLine.charAt(0);
    if (marker === '+') {
      headLine += 1;
      record({
        type: 'added',
        headLine: headLine - 1,
        content: rawLine.slice(1),
      });
    } else if (marker === '-') {
      baseLine += 1;
      record({
        type: 'deleted',
        baseLine: baseLine - 1,
        content: rawLine.slice(1),
      });
    } else if (marker === ' ' || marker === '\t') {
      baseLine += 1;
      headLine += 1;
      record({ type: 'context', baseLine: baseLine - 1, headLine: headLine - 1, content: rawLine.slice(1) });
    } else if (rawLine.startsWith('\\ No newline at end of file')) {
      // This meta line does not occupy a position.
      continue;
    } else {
      // Anything outside a hunk ends parsing for this file.
      break;
    }
  }

  return { positions, baseLineToPositions, headLineToPositions };
}
