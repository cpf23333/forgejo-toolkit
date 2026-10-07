/**
 * The settings page's six groups, as **data** (`docs/design/settings-page.md`
 * §9.2, §9.4 rule 1, §9.7's 「分组映射」 row).
 *
 * The page used to be eleven blocks in one scroll column with no navigation at
 * all (measured 2026-10-06: 4768 lines, eleven `section.setting-section`
 * elements, five of them from the AI work). §9 fixes that by giving the page a
 * home with width — an editor-area tab — and a group navigation inside it.
 *
 * Why the mapping is a module rather than a table written into the template:
 *
 * - It is the same fact the page's navigation, its panes and its test all read,
 *   and the test is the one that has to prove the fact holds. A template cannot
 *   be imported by a test, and a second copy of the mapping written into the
 *   test is exactly the drift this table exists to prevent.
 * - `settingsSurface.test.ts` (the drift guard) holds the manifest against the
 *   webview catalogue: every setting the manifest contributes is rendered by this
 *   page, so a key in that catalogue is a setting some group has to own. The guard
 *   says nothing about *where* a rendered setting lives, so this table is what
 *   answers that — and `Settings.groups.test.ts` holds the two together: every key
 *   that guard counts as rendered belongs to exactly one group here, and every
 *   group's blocks are inside that group's pane.
 *
 * The block list is written as the i18n key of each block's own heading, which is
 * also what the section carries as its `data-block` attribute, so the test can
 * find the rendered block and ask which pane it is in.
 */

/** One of the page's six groups. */
export type SettingsGroupId = 'general' | 'instances' | 'notifications' | 'mcp' | 'ai' | 'worktree';

export interface SettingsGroup {
  id: SettingsGroupId;
  /**
   * The group's own name — the navigation label, the pane's heading and (in the
   * wide shape) the tab's accessible name. One key for all three: the maintainer
   * asked for the name to appear as a heading in the content as well as in the
   * navigation (§9.6 question 5), and two keys would let the two disagree.
   */
  labelKey: string;
  /** The i18n key of every block inside this group, in render order. */
  blocks: readonly string[];
  /**
   * Every full setting id the blocks in this group render. It is the drift
   * guard's own vocabulary (`en.json`'s `settings` keys that start with
   * `forgejoToolkit.`), so a group cannot claim a setting the page does not
   * render, and a newly rendered setting cannot be left without a home. A group
   * may render none — 「实例」 renders the instance list and its editor, which
   * are not settings.
   */
  settingIds: readonly string[];
}

/**
 * The six groups, in navigation order.
 *
 * The maintainer's ruling of 2026-10-06 is six, not the seven this record first
 * proposed: the AI features, the endpoint configuration and the per-feature
 * overrides answer one question and share one group named 「AI」, with the
 * transport row and its capability block inside it. The ruling also fixed the
 * order here and the group the page opens on (`DEFAULT_SETTINGS_GROUP`).
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'general',
    labelKey: 'settings.groups.general',
    // The page's own switches: the language changes the panel the user is
    // looking at, the debug log is this page's diagnostic exit (§1.2), and the
    // last block is the developer passage `forgejoToolkit.useMockApi` lives in
    // (§1.3, §3.2) — a page-level setting with no other section to belong to, so
    // it is its own block here rather than a seventh group.
    //
    // 「设置与数据」 (export/import) is the reasoning that grouping follows the
    // **subsystem a thing acts on**, not the shape of its payload: the file is the
    // whole configuration (v3 carries the `ai` section too), it belongs to no
    // subsystem, and under 「实例」 a reader would reasonably expect instances only
    // (maintainer's ruling, 2026-10-06). It sits before the developer passage so
    // the dev-only switch stays last.
    blocks: ['settings.language', 'settings.debug.title', 'settings.data.title', 'settings.developer.title'],
    settingIds: ['forgejoToolkit.locale', 'forgejoToolkit.debug', 'forgejoToolkit.useMockApi'],
  },
  {
    id: 'instances',
    labelKey: 'settings.groups.instances',
    // The list, its Add control and its editor state — the editor is a state of the
    // page rather than a block, so it is named by the block it is opened from and
    // returns to (§9.4 rule 3). Export/import used to live in this block's header;
    // it moved to 「通用」 → 「设置与数据」 (2026-10-06) because what it writes is the
    // whole configuration file, not instances.
    blocks: ['settings.savedInstances'],
    settingIds: [],
  },
  {
    id: 'notifications',
    labelKey: 'settings.groups.notifications',
    // The polling switch, the interval it paces itself by and the multi-window
    // lease answer one question: why the badge went quiet (§9.2). The interval
    // joined them when the page took it over from VS Code's own editor (§1.3).
    blocks: ['settings.notifications.title'],
    settingIds: [
      'forgejoToolkit.notificationPollingEnabled',
      'forgejoToolkit.notificationPollingInterval',
      'forgejoToolkit.multiWindowLease',
    ],
  },
  {
    id: 'mcp',
    labelKey: 'settings.groups.mcp',
    // The master switch, the three per-tool gates and where the audit goes: one
    // confirmation model, which is why the audit ledger is not filed elsewhere.
    blocks: ['settings.mcp.title'],
    settingIds: [
      'forgejoToolkit.mcpEnabled',
      'forgejoToolkit.mcpWriteTools.createIssueComment',
      'forgejoToolkit.mcpWriteTools.submitPullReview',
      'forgejoToolkit.mcpWriteTools.cancelActionRun',
      'forgejoToolkit.mcpWriteAuditToFile',
    ],
  },
  {
    id: 'ai',
    labelKey: 'settings.groups.ai',
    // The whole AI area in one group (the maintainer's ruling): the master switch
    // first (§3.2), then each feature with its own switch and egress scope, then
    // the endpoint configuration (transport, capability block, timeout, endpoint
    // list, default endpoint and model, rejected entries) and the per-feature
    // overrides, which only read as overrides beside the default they override.
    blocks: [
      'settings.ai.title',
      'settings.aiPreReview.title',
      'settings.prDescription.title',
      'settings.issueTriage.title',
      'settings.aiProviders.title',
      'settings.aiProviders.bindings.title',
    ],
    settingIds: [
      'forgejoToolkit.aiEnabled',
      'forgejoToolkit.aiPreReview',
      'forgejoToolkit.aiPreReviewPromptScope',
      'forgejoToolkit.aiPreReviewModel',
      'forgejoToolkit.prDescription',
      'forgejoToolkit.prDescriptionPromptScope',
      'forgejoToolkit.issueTriage',
      'forgejoToolkit.issueTriagePromptScope',
      'forgejoToolkit.aiProviders',
      'forgejoToolkit.aiTransport',
      'forgejoToolkit.aiDefaultProvider',
      'forgejoToolkit.aiDefaultModel',
      'forgejoToolkit.aiModelBindings',
      'forgejoToolkit.aiModelRequestTimeoutMs',
    ],
  },
  {
    id: 'worktree',
    labelKey: 'settings.groups.worktree',
    // The PR worktree face: git-related and AI-free, and the landing place the
    // git area grows into.
    blocks: ['settings.worktree.title'],
    settingIds: ['forgejoToolkit.worktreeOpenMode', 'forgejoToolkit.worktreeCacheDirectory'],
  },
];

/**
 * The group the page opens on, fixed by the maintainer: 「通用」.
 *
 * It is deliberately **not** remembered — not across the tab's life and not
 * across a reopen (§9.3, §9.4 rule 5): reopening the tab is a new page that
 * re-reads everything, and a navigation preference is not a setting the page may
 * invent (the drift guard's ledger only knows "rendered" and "native-only").
 */
export const DEFAULT_SETTINGS_GROUP: SettingsGroupId = 'general';

/**
 * The narrowest page width at which the wide shape — a vertical navigation
 * column beside the content — is the better one (`docs/design/settings-page.md`
 * §9.3, measured rather than guessed).
 *
 * Below it the page keeps one content column and puts the group selector in a
 * sticky bar at the top. The failure the number exists to avoid is a *third*
 * column: the page inside the sidebar (~233–297 px measured) already had the
 * activity bar and could not carry another, and a tab dragged narrow, or split
 * into a grid cell, is that same situation.
 *
 * The number is arithmetic over two **measured** values and one the page's own
 * stylesheet names:
 *
 * - the navigation column renders **150 px** wide (measured in the dev host at
 *   2026-10-06: `.settings-nav` 150 px, the page 914 px, the content column
 *   740 px);
 * - the column gap is **24 px** (`.settings-list.wide-nav`);
 * - the content column's floor is **358 px**, the panel width this page was
 *   designed against and the width its own stylesheet comment records.
 *
 * 150 + 24 + 358 = 532. The wide shape may therefore appear only from 532 px up;
 * one pixel below it the page would be showing a content column narrower than the
 * one the page was written for.
 */
export const WIDE_NAV_MIN_WIDTH = 532;
