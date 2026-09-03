import type { ForgejoContentEntry } from '../../../api/types';

export const mockRootContents: ForgejoContentEntry[] = [
  {
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    sha: 'readme-sha',
    size: 120,
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
    size: 450,
  },
];

export const mockSrcContents: ForgejoContentEntry[] = [
  {
    name: 'index.ts',
    path: 'src/index.ts',
    type: 'file',
    sha: 'index-sha',
    size: 200,
  },
  {
    name: 'utils',
    path: 'src/utils',
    type: 'dir',
    sha: 'utils-dir-sha',
  },
];

export const mockReadmeContent: ForgejoContentEntry = {
  name: 'README.md',
  path: 'README.md',
  type: 'file',
  sha: 'readme-sha',
  size: 120,
  content: btoa('# Demo Repository\n\nThis is a mock repository for offline development.'),
  encoding: 'base64',
};

export const mockIndexTsContent: ForgejoContentEntry = {
  name: 'index.ts',
  path: 'src/index.ts',
  type: 'file',
  sha: 'index-sha',
  size: 200,
  content: btoa('export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n'),
  encoding: 'base64',
};
