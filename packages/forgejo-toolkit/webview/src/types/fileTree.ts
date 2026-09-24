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

/**
 * Injection key for the diff tree's roving tabindex: the tree owner
 * (`DiffFileList`) provides the path of the row that owns the tree's single tab
 * stop, and every `FileTreeNode` re-provides its own path to its children, so
 * one reactive value drives the `tabindex` of each nested row.
 */
export const fileTreeFocusedPathKey = Symbol('file-tree-focused-path');
