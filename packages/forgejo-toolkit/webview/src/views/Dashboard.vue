<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import { vscode } from '../composables/vscode';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import type { ForgejoRepository, ForgejoIssue, ForgejoPullRequest } from '../types/api';

const { t } = useI18n();
const state = useAppState();

function openOnboarding() {
  vscode.postMessage({ command: 'openOnboardingPanel' });
}

type Tab = 'repositories' | 'issues' | 'pullRequests';

const activeTab = computed<Tab>({
  get: () => state.dashboardActiveTab.value,
  set: (tab) => state.setDashboardActiveTab(tab),
});
const expandedInstances = ref<Set<string>>(new Set());
const expandedOwners = ref<Set<string>>(new Set());

function setTab(tab: Tab) {
  state.setDashboardActiveTab(tab);
}

function ownerKey(instanceId: string, owner: string): string {
  return `${instanceId}:${owner}`;
}

function reposByOwner(instanceId: string): Record<string, ForgejoRepository[]> {
  const repos = state.repositories.value.get(instanceId) ?? [];
  const grouped: Record<string, ForgejoRepository[]> = {};
  for (const repo of repos) {
    const owner = repo.owner.login;
    if (!grouped[owner]) {
      grouped[owner] = [];
    }
    grouped[owner].push(repo);
  }
  for (const owner of Object.keys(grouped)) {
    grouped[owner].sort((a, b) => a.name.localeCompare(b.name));
  }
  return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)));
}

function expandOwner(key: string) {
  if (expandedOwners.value.has(key)) {
    return;
  }
  expandedOwners.value.add(key);
}

function collapseOwner(key: string) {
  expandedOwners.value.delete(key);
}

function handleInstanceClick(instanceId: string) {
  if (expandedInstances.value.has(instanceId)) {
    collapseInstance(instanceId);
  } else {
    expandInstance(instanceId);
  }
}

function handleOwnerClick(instanceId: string, owner: string) {
  const key = ownerKey(instanceId, owner);
  if (expandedOwners.value.has(key)) {
    collapseOwner(key);
  } else {
    expandOwner(key);
  }
}

function autoExpandFirstOwner(instanceId: string) {
  const owners = Object.keys(reposByOwner(instanceId));
  if (owners.length === 0) {
    return;
  }
  const hasExpandedOwner = Array.from(expandedOwners.value).some((key) => key.startsWith(`${instanceId}:`));
  if (!hasExpandedOwner) {
    expandOwner(ownerKey(instanceId, owners[0]));
  }
}

function expandInstance(instanceId: string) {
  if (expandedInstances.value.has(instanceId)) {
    return;
  }
  expandedInstances.value.add(instanceId);
  nextTick(() => {
    loadForTab(instanceId);
    autoExpandFirstOwner(instanceId);
  });
}

function collapseInstance(instanceId: string) {
  expandedInstances.value.delete(instanceId);
  for (const key of Array.from(expandedOwners.value)) {
    if (key.startsWith(`${instanceId}:`)) {
      expandedOwners.value.delete(key);
    }
  }
}

function loadForTab(instanceId: string) {
  if (activeTab.value === 'repositories') {
    state.loadRepositories(instanceId);
  } else if (activeTab.value === 'issues') {
    state.loadMyIssues(instanceId);
  } else {
    state.loadMyPullRequests(instanceId);
  }
}

watch(activeTab, () => {
  expandedInstances.value.forEach((id) => loadForTab(id));
});

watch(
  () => state.repositories.value,
  () => {
    expandedInstances.value.forEach((id) => autoExpandFirstOwner(id));
  },
  { deep: true },
);

watch(
  () => state.instances.value,
  (newInstances) => {
    if (newInstances.length > 0 && expandedInstances.value.size === 0) {
      expandInstance(newInstances[0].id);
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (state.instances.value.length > 0 && expandedInstances.value.size === 0) {
    expandInstance(state.instances.value[0].id);
  }
});

function isActionClick(event: Event): boolean {
  return !!(event.target as HTMLElement).closest('.tree-actions');
}

function openRepo(event: Event, instanceId: string, repo: ForgejoRepository) {
  if (isActionClick(event)) {
    return;
  }
  state.openRepoDetail(instanceId, repo.owner.login, repo.name);
}

function parseOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    // ignore
  }
  return undefined;
}

function openIssue(event: Event, instanceId: string, issue: ForgejoIssue) {
  if (isActionClick(event)) {
    return;
  }
  const ownerRepo = issue.repository?.full_name
    ? { owner: issue.repository.full_name.split('/')[0], repo: issue.repository.full_name.split('/')[1] }
    : parseOwnerRepo(issue.html_url);
  if (ownerRepo) {
    state.openIssueDetail(instanceId, ownerRepo.owner, ownerRepo.repo, issue.number);
  }
}

function openPullRequest(event: Event, instanceId: string, pr: ForgejoPullRequest) {
  if (isActionClick(event)) {
    return;
  }
  const ownerRepo = parseOwnerRepo(pr.html_url);
  if (ownerRepo) {
    state.openPullRequestDetail(instanceId, ownerRepo.owner, ownerRepo.repo, pr.number);
  }
}

function cloneUrl(instance: { url: string }, repo: ForgejoRepository): string {
  return `${instance.url}/${repo.full_name}.git`;
}

function formatError(key: string): string {
  return t('dashboard.error', { message: state.errors.value.get(key) ?? '' });
}

function repoCount(instanceId: string): number {
  return state.repositories.value.get(instanceId)?.length ?? 0;
}

function issueCount(instanceId: string): number {
  return state.myIssues.value.get(instanceId)?.length ?? 0;
}

function prCount(instanceId: string): number {
  return state.myPullRequests.value.get(instanceId)?.length ?? 0;
}

function badgeCount(instanceId: string): number {
  if (activeTab.value === 'repositories') {
    return repoCount(instanceId);
  }
  if (activeTab.value === 'issues') {
    return issueCount(instanceId);
  }
  return prCount(instanceId);
}

function loadingKey(instanceId: string): string {
  if (activeTab.value === 'repositories') {
    return `repos-${instanceId}`;
  }
  if (activeTab.value === 'issues') {
    return `issues-${instanceId}`;
  }
  return `pulls-${instanceId}`;
}

const instances = computed(() => state.instances.value);
const repositories = computed(() => state.repositories.value);
const myIssues = computed(() => state.myIssues.value);
const myPullRequests = computed(() => state.myPullRequests.value);
const loading = computed(() => state.loading.value);
const errors = computed(() => state.errors.value);
</script>

<template>
  <div class="dashboard">
    <div v-if="instances.length === 0" class="empty">
      <p>{{ t('dashboard.emptyTitle') }}</p>
      <p>{{ t('dashboard.emptyHint', { button: t('dashboard.openOnboarding') }) }}</p>
      <VscodeButton variant="primary" @click="openOnboarding">
        {{ t('dashboard.openOnboarding') }}
      </VscodeButton>
    </div>

    <div v-else class="dashboard-content">
      <div class="tabs">
        <button
          v-for="tab in ['repositories', 'issues', 'pullRequests'] as Tab[]"
          :key="tab"
          class="tab-button"
          :class="{ active: activeTab === tab }"
          @click="setTab(tab)"
        >
          {{ t(`dashboard.tabs.${tab}`) }}
        </button>
      </div>

      <div class="instances">
        <vscode-tree indent-guides="onHover">
          <vscode-tree-item
            v-for="instance in instances"
            :key="instance.id"
            branch
            :open="expandedInstances.has(instance.id)"
            @click="handleInstanceClick(instance.id)"
          >
            {{ instance.url }} · {{ instance.username }}
            <span class="badge" slot="decoration">{{ badgeCount(instance.id) }}</span>
            <span slot="description">
              <span v-if="loading.get(loadingKey(instance.id))" class="loading">
                <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
              </span>
              <span v-else-if="errors.get(loadingKey(instance.id))" class="error">{{
                formatError(loadingKey(instance.id))
              }}</span>
            </span>
            <template v-if="activeTab === 'repositories'">
              <template v-if="loading.get(loadingKey(instance.id))">
                <vscode-tree-item>
                  <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
                </vscode-tree-item>
              </template>
              <template v-else-if="!repositories.get(instance.id)?.length">
                <vscode-tree-item>{{ t('dashboard.noRepositories') }}</vscode-tree-item>
              </template>
              <template v-else>
                <vscode-tree-item
                  v-for="(ownerRepos, owner) in reposByOwner(instance.id)"
                  :key="owner"
                  branch
                  :open="expandedOwners.has(ownerKey(instance.id, owner))"
                  @click="handleOwnerClick(instance.id, owner)"
                >
                  {{ owner }}
                  <span class="badge" slot="decoration">{{ ownerRepos.length }}</span>
                  <vscode-tree-item
                    v-for="repo in ownerRepos"
                    :key="repo.id"
                    @click.capture="openRepo($event, instance.id, repo)"
                  >
                    <span class="tree-repo-name">{{ repo.name }}</span>
                    <span class="tree-repo-meta" slot="description">
                      {{ t('dashboard.branch') }}: {{ repo.default_branch }} · {{ t('dashboard.stars') }}:
                      {{ repo.stars_count }} · {{ t('dashboard.forks') }}: {{ repo.forks_count }}
                    </span>
                    <span slot="actions" class="tree-actions">
                      <a
                        href="#"
                        :title="t('dashboard.actions.open')"
                        @click.prevent="state.openExternal(repo.html_url)"
                      >
                        <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path
                            d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                          />
                        </svg>
                      </a>
                      <a
                        href="#"
                        :title="t('dashboard.actions.copyClone')"
                        @click.prevent="state.copyToClipboard(cloneUrl(instance, repo))"
                      >
                        <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path
                            d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                          />
                        </svg>
                      </a>
                    </span>
                  </vscode-tree-item>
                </vscode-tree-item>
              </template>
            </template>
            <template v-else-if="activeTab === 'issues'">
              <template v-if="loading.get(loadingKey(instance.id))">
                <vscode-tree-item>
                  <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
                </vscode-tree-item>
              </template>
              <template v-else-if="!myIssues.get(instance.id)?.length">
                <vscode-tree-item>{{ t('dashboard.noIssues') }}</vscode-tree-item>
              </template>
              <template v-else>
                <vscode-tree-item
                  v-for="issue in myIssues.get(instance.id)"
                  :key="issue.id"
                  @click.capture="openIssue($event, instance.id, issue)"
                >
                  #{{ issue.number }} {{ issue.title }}
                  <span class="tree-issue-meta" slot="description">{{ issue.state }}</span>
                  <span slot="actions" class="tree-actions">
                    <a
                      href="#"
                      :title="t('dashboard.actions.open')"
                      @click.prevent="state.openExternal(issue.html_url)"
                    >
                      <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                        />
                      </svg>
                    </a>
                    <a
                      href="#"
                      :title="t('dashboard.actions.copyUrl')"
                      @click.prevent="state.copyToClipboard(issue.html_url)"
                    >
                      <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                        />
                      </svg>
                    </a>
                  </span>
                </vscode-tree-item>
              </template>
            </template>
            <template v-else-if="activeTab === 'pullRequests'">
              <template v-if="loading.get(loadingKey(instance.id))">
                <vscode-tree-item>
                  <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
                </vscode-tree-item>
              </template>
              <template v-else-if="!myPullRequests.get(instance.id)?.length">
                <vscode-tree-item>{{ t('dashboard.noPullRequests') }}</vscode-tree-item>
              </template>
              <template v-else>
                <vscode-tree-item
                  v-for="pr in myPullRequests.get(instance.id)"
                  :key="pr.id"
                  @click.capture="openPullRequest($event, instance.id, pr)"
                >
                  #{{ pr.number }} {{ pr.title }}
                  <span class="tree-pr-meta" slot="description">{{ pr.state }}</span>
                  <span slot="actions" class="tree-actions">
                    <a href="#" :title="t('dashboard.actions.open')" @click.prevent="state.openExternal(pr.html_url)">
                      <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                        />
                      </svg>
                    </a>
                    <a
                      href="#"
                      :title="t('dashboard.actions.copyUrl')"
                      @click.prevent="state.copyToClipboard(pr.html_url)"
                    >
                      <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                        />
                      </svg>
                    </a>
                  </span>
                </vscode-tree-item>
              </template>
            </template>
          </vscode-tree-item>
        </vscode-tree>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--vscode-descriptionForeground);
}

.empty p {
  margin: 8px 0;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 8px;
}

.tab-button {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.9em;
  border-radius: 4px;
}

.tab-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.tab-button.active {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.badge {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 0.75em;
  flex-shrink: 0;
}

.loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 4px 0;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
  padding: 4px 0;
}

.tree-repo-name,
.tree-repo-meta,
.tree-issue-meta,
.tree-pr-meta {
  font-size: 0.85em;
}

.tree-repo-meta,
.tree-issue-meta,
.tree-pr-meta {
  color: var(--vscode-descriptionForeground);
}

.tree-actions {
  display: flex;
  gap: 8px;
}

.icon-link,
.icon-copy {
  width: 14px;
  height: 14px;
  display: block;
  color: var(--vscode-descriptionForeground);
}

.icon-link:hover,
.icon-copy:hover {
  color: var(--vscode-textLink-foreground);
}

.tab-loading-ring {
  width: 14px;
  height: 14px;
  vertical-align: middle;
}
</style>
