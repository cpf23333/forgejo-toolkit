import type { ForgejoChangedFile } from './api';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  file?: ForgejoChangedFile;
  children: FileTreeNode[];
  expanded: boolean;
  checked: boolean;
  indeterminate: boolean;
}
