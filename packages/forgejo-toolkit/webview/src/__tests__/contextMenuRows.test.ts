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

  it('binds a marker on the settings page’s two row types', () => {
    const settings = sourceOf('views/Settings.vue');
    // The instance row and the endpoint row, each naming the entity the page can look up.
    expect(settings).toContain("webviewSection: 'settingsInstanceRow'");
    expect(settings).toContain('forgejoInstanceId: instance.id');
    expect(settings).toContain("webviewSection: 'settingsEndpointRow'");
    expect(settings).toContain('forgejoProviderId: entry.id');
    expect(settings).toContain('contextMenuAttribute(');
  });

  it('binds a marker on the pre-review suggestion cards, and the field marker on their editors', () => {
    const panel = sourceOf('AiPreReviewPanel.vue');
    // The card keeps the panel's items, and the textarea inside it keeps the platform's
    // cut/copy/paste: a card whose editor lost them would be un-editable by mouse.
    expect(panel).toContain("webviewSection: 'preReviewSuggestion'");
    expect(panel).toContain('forgejoPanelId: panelId');
    expect(panel).toContain('forgejoSuggestionIndex: candidate.index');
    expect(panel).toContain(':data-vscode-context="contextMenuFieldAttribute()"');
  });

  it('binds the log marker on the job log and listens for the selection it publishes', () => {
    const view = sourceOf('views/ActionRunDetail.vue');
    // The marker is bound from the tracked selection and is absent (undefined) when the
    // selection is not in that log, which is what keeps a selection-less log suppressed.
    expect(view).toContain(':data-vscode-context="jobLogContext(job.id)"');
    expect(view).toContain('logSelectionAttribute(logSelectionText.value)');
    expect(view).toContain("document.addEventListener('selectionchange', trackLogSelection)");
    expect(view).toContain("document.removeEventListener('selectionchange', trackLogSelection)");
  });

  it('publishes every section this batch contributes, and no more', () => {
    const all = [
      sourceOf('views/Notifications.vue'),
      sourceOf('components/DashboardInstanceItem.vue'),
      sourceOf('views/RepoIssues.vue'),
      sourceOf('views/RepoPullRequests.vue'),
      sourceOf('views/Settings.vue'),
      sourceOf('AiPreReviewPanel.vue'),
    ].join('\n');

    // Each section the views spell themselves is written by at least one of them, and
    // the union of their `webviewSection` literals is exactly that list. `runLog` is
    // published by `logSelectionAttribute` (asserted in `utils/__tests__/contextMenu.test.ts`)
    // rather than written in a template, so it is outside both halves of this scan.
    const templateSections = CONTEXT_MENU_SECTIONS.filter((section) => section !== 'runLog');
    for (const section of templateSections) {
      expect(all, `no row publishes ${section}`).toContain(`webviewSection: '${section}'`);
    }
    const used = [...all.matchAll(/webviewSection: '([a-zA-Z]+)'/g)].map((match) => match[1]);
    expect([...new Set(used)].sort()).toEqual([...templateSections].sort());
  });
});
