import { describe, expect, it } from 'vitest';
import { CONTEXT_MENU_SECTIONS } from '../utils/contextMenu';

/**
 * Every row family of batch 1 binds a marker, and the sections they publish are the
 * ones `utils/contextMenu.ts` lets through the policy.
 *
 * The rendered half of this is `Notifications.contextMenu.test.ts` (one row, values
 * and all). This side is the drift guard for the other three sites — the dashboard's
 * repository, issue and pull-request rows and the two list pages — because a row that
 * lost its binding would simply stop offering its items, silently, with every other
 * test still green. It reads the sources the way `entryGraph.test.ts` and the
 * `vscodeElements` guard do, so it runs without mounting three route views.
 */

const sources = import.meta.glob('../**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/** The source of a view/component, by the path this file's own directory resolves to. */
function sourceOf(file: string): string {
  const key = Object.keys(sources).find((candidate) => candidate.endsWith(`/${file}`));
  expect(key, `${file} is missing`).toBeDefined();
  return sources[key!];
}

describe('context-menu row bindings', () => {
  it('binds a marker on the notification rows', () => {
    const source = sourceOf('views/Notifications.vue');
    expect(source).toContain('contextMenuAttribute(notificationContext(');
    expect(source).toContain("webviewSection: 'notificationRow'");
  });

  it('binds a marker on the dashboard’s three row types', () => {
    const source = sourceOf('components/DashboardInstanceItem.vue');
    expect(source).toContain(':data-vscode-context="repositoryRowContext(repo)"');
    expect(source).toContain(':data-vscode-context="issueRowContext(issue)"');
    expect(source).toContain(':data-vscode-context="pullRequestRowContext(pr)"');
    expect(source).toContain("webviewSection: 'repositoryRow'");
    expect(source).toContain("webviewSection: 'issueRow'");
    expect(source).toContain("webviewSection: 'pullRequestRow'");
  });

  it('binds a marker on both repository list pages', () => {
    const issues = sourceOf('views/RepoIssues.vue');
    expect(issues).toContain(':data-vscode-context="contextMenuAttribute(issueContext(issue))"');
    expect(issues).toContain("webviewSection: 'issueRow'");

    const pulls = sourceOf('views/RepoPullRequests.vue');
    expect(pulls).toContain(':data-vscode-context="contextMenuAttribute(pullRequestContext(pr))"');
    expect(pulls).toContain("webviewSection: 'pullRequestRow'");
  });

  it('publishes every section this batch contributes, and no more', () => {
    const all = [
      sourceOf('views/Notifications.vue'),
      sourceOf('components/DashboardInstanceItem.vue'),
      sourceOf('views/RepoIssues.vue'),
      sourceOf('views/RepoPullRequests.vue'),
    ].join('\n');

    // Each of the four sections is written by at least one row, and the union of the
    // `webviewSection` literals used across those rows is exactly the list the policy
    // (and the manifest's `when` clauses) know about.
    for (const section of CONTEXT_MENU_SECTIONS) {
      expect(all, `no row publishes ${section}`).toContain(`webviewSection: '${section}'`);
    }
    const used = [...all.matchAll(/webviewSection: '([a-zA-Z]+)'/g)].map((match) => match[1]);
    expect([...new Set(used)].sort()).toEqual([...CONTEXT_MENU_SECTIONS].sort());
  });
});
