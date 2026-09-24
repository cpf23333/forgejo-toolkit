import type { ForgejoContentEntry } from '../../../api/types';

// Payloads of the fixture tree's files. The listings below derive their `size`
// from these strings, so a listing and the file it describes can never disagree
// about how big the file is — the real API answers a listing with the file's
// real size, and the clients use it to tell a withheld payload from an empty
// file.
const README_TEXT = '# Demo Repository\n\nThis is a mock repository for offline development.';
const INDEX_TS_TEXT = 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';
const PACKAGE_JSON_TEXT = '{\n  "name": "demo-repo",\n  "private": true\n}\n';

/**
 * The body of a file the tree carries without a stored payload. The requested
 * ref is echoed into the text so the diff editor's old/new halves stay
 * distinguishable (that is what the old contents catch-all was for); the
 * generated body is why such a file's listing size is only exact for the
 * default branch.
 */
export function mockPlaceholderFileText(filepath: string, ref?: string): string {
  return `// Mock content for ${filepath}\n// ref: ${ref ?? 'default branch'}\n`;
}

/**
 * Directory listings, one per directory the contents endpoint answers. Entries
 * never carry `content`: the API populates it only for the single-file response
 * (upstream calls `GetContents` with `forList=true`), so a listing that carried
 * one would describe a response the server cannot send. A `dir` entry carries no
 * `size` either — Forgejo omits a zero size — while every `file` entry carries
 * its real size.
 */
export const mockRootContents: ForgejoContentEntry[] = [
  {
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    sha: 'readme-sha',
    size: README_TEXT.length,
  },
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    sha: 'src-dir-sha',
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file',
    sha: 'package-sha',
    size: PACKAGE_JSON_TEXT.length,
  },
];

export const mockSrcContents: ForgejoContentEntry[] = [
  {
    name: 'index.ts',
    path: 'src/index.ts',
    type: 'file',
    sha: 'index-sha',
    size: INDEX_TS_TEXT.length,
  },
  {
    name: 'utils',
    path: 'src/utils',
    type: 'dir',
    sha: 'utils-dir-sha',
  },
];

/** Children of `src/utils`, so the nested directory the listing advertises is real. */
export const mockSrcUtilsContents: ForgejoContentEntry[] = [
  {
    name: 'format.ts',
    path: 'src/utils/format.ts',
    type: 'file',
    sha: 'format-sha',
    size: mockPlaceholderFileText('src/utils/format.ts').length,
  },
];

/**
 * The `docs` subtree exists so walkthroughs (and the tests that read arbitrary
 * paths, e.g. the MCP `get_file_content` tool) have files outside `src` to open;
 * its bodies are generated placeholders. `docs` is deliberately absent from
 * `mockRootContents`: `mcp/__tests__/tools.test.ts` pins that listing to
 * `['README.md', 'src', 'package.json']`, so adding it there breaks a test that
 * this change is not allowed to touch. Add it here (and to that expectation)
 * once that test is updated.
 */
export const mockDocsContents: ForgejoContentEntry[] = [
  {
    name: 'guide.md',
    path: 'docs/guide.md',
    type: 'file',
    sha: 'guide-sha',
    size: mockPlaceholderFileText('docs/guide.md').length,
  },
  {
    name: 'any.md',
    path: 'docs/any.md',
    type: 'file',
    sha: 'any-sha',
    size: mockPlaceholderFileText('docs/any.md').length,
  },
];

/** Directory listings keyed by request path; `''` is the repository root. */
export const mockContentListings: Record<string, ForgejoContentEntry[]> = {
  '': mockRootContents,
  src: mockSrcContents,
  docs: mockDocsContents,
  'src/utils': mockSrcUtilsContents,
};

/** Stored payloads for tree files, keyed by path. */
export const mockContentFileTexts: Record<string, string> = {
  'package.json': PACKAGE_JSON_TEXT,
};

function filePathsOf(entries: ForgejoContentEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === 'file' && entry.path ? [entry.path] : []));
}

/**
 * Every path the contents endpoint answers with a file body, derived from the
 * listings above so the two cannot drift. A path outside this set is a 404: the
 * handler used to invent a file for *any* path, which made both the client's
 * 404 handling and its "that path is a directory" branch unreachable (a request
 * for `src` answered a file instead of `src`'s children).
 */
export const mockContentFilePaths: string[] = [
  ...filePathsOf(mockRootContents),
  ...filePathsOf(mockSrcContents),
  ...filePathsOf(mockDocsContents),
  ...filePathsOf(mockSrcUtilsContents),
];

export const mockReadmeContent: ForgejoContentEntry = {
  name: 'README.md',
  path: 'README.md',
  type: 'file',
  sha: 'readme-sha',
  size: README_TEXT.length,
  content: btoa(README_TEXT),
  encoding: 'base64',
};

export const mockIndexTsContent: ForgejoContentEntry = {
  name: 'index.ts',
  path: 'src/index.ts',
  type: 'file',
  sha: 'index-sha',
  size: INDEX_TS_TEXT.length,
  content: btoa(INDEX_TS_TEXT),
  encoding: 'base64',
};
