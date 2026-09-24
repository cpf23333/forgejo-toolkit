/**
 * How many children a single directory level mounts at once in the repository
 * file browser. `vscode-tree-item` is a custom element, so every entry costs a
 * host element plus a shadow root even while a collapsed branch hides it with
 * CSS; the host reply for a directory is uncapped, so a 5k-entry directory used
 * to create 5k of them during a single render. The rest is revealed in batches
 * of the same size through the "show more" row, so no entry becomes
 * unreachable.
 */
export const FILE_TREE_LEVEL_CAP = 200;
