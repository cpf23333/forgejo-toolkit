<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, globalSearchKey } from '../composables/useAppState';
import type { ForgejoIssue, ForgejoPullRequest, ForgejoRepository, GlobalSearchResult } from '../types/api';
import type { ForgejoInstance } from '../types/instance';
import ViewTabs from '../components/ViewTabs.vue';

const { t } = useI18n();
const state = useAppState();

type Tab = 'all' | 'repositories' | 'issues' | 'pullRequests';

const activeTab = ref<Tab>('all');
const query = ref('');
const stateFilter = ref<'open' | 'closed' | 'all'>('all');

const instances = computed(() => state.instances.value);
const loading = computed(() => state.loading);
const errors = computed(() => state.errors);

const selectedInstanceMap = ref<Record<string, boolean>>({});

const targetInstances = computed<ForgejoInstance[]>(() => {
  return instances.value.filter((instance) => selectedInstanceMap.value[instance.id]);
});

const allInstancesSelected = computed<boolean>({
  get: () => {
    if (instances.value.length === 0) {
      return false;
    }
    return instances.value.every((instance) => selectedInstanceMap.value[instance.id]);
  },
  set: (checked: boolean) => {
    const next: Record<string, boolean> = {};
    for (const instance of instances.value) {
      next[instance.id] = checked;
    }
    selectedInstanceMap.value = next;
  },
});

function isStateFilterVisible(): boolean {
  return activeTab.value === 'all' || activeTab.value === 'issues' || activeTab.value === 'pullRequests';
}

function currentQuery(): string {
  return query.value.trim();
}

function searchKey(instanceId: string): string {
  return globalSearchKey(instanceId, activeTab.value, currentQuery(), stateFilter.value);
}

function resultFor(instanceId: string): GlobalSearchResult | undefined {
  return state.globalSearchResults.value.get(searchKey(instanceId));
}

function isLoading(): boolean {
  const q = currentQuery();
  if (!q) {
    return false;
  }
  for (const instance of targetInstances.value) {
    if (loading.value.get(globalSearchKey(instance.id, activeTab.value, q, stateFilter.value))) {
      return true;
    }
  }
  return false;
}

function hasQueried(): boolean {
  const q = currentQuery();
  if (!q) {
    return false;
  }
  for (const instance of targetInstances.value) {
    if (state.globalSearchResults.value.has(globalSearchKey(instance.id, activeTab.value, q, stateFilter.value))) {
      return true;
    }
    if (errors.value.has(globalSearchKey(instance.id, activeTab.value, q, stateFilter.value))) {
      return true;
    }
  }
  return false;
}

function hasResults(): boolean {
  for (const instance of targetInstances.value) {
    const result = resultFor(instance.id);
    if (!result) {
      continue;
    }
    if (activeTab.value === 'all') {
      if (result.repositories.length || result.issues.length || result.pullRequests.length) {
        return true;
      }
    } else if (result[activeTab.value].length) {
      return true;
    }
  }
  return false;
}

function runSearch() {
  const q = currentQuery();
  if (!q || targetInstances.value.length === 0) {
    return;
  }
  for (const instance of targetInstances.value) {
    state.loadGlobalSearch(instance.id, activeTab.value, q, stateFilter.value);
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    runSearch();
  }
}

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

function repoCloneUrl(instance: ForgejoInstance, repo: ForgejoRepository): string {
  return `${instance.url}/${repo.full_name}.git`;
}

function formatError(instanceId: string): string {
  const key = searchKey(instanceId);
  return t('dashboard.error', { message: errors.value.get(key) ?? '' });
}

function visibleInstances(): ForgejoInstance[] {
  const q = currentQuery();
  if (!q) {
    return [];
  }
  return targetInstances.value.filter((instance) => {
    const key = globalSearchKey(instance.id, activeTab.value, q, stateFilter.value);
    return loading.value.get(key) || errors.value.has(key) || resultFor(instance.id);
  });
}

function initializeInstanceMap() {
  const next: Record<string, boolean> = { ...selectedInstanceMap.value };
  for (const instance of instances.value) {
    if (!(instance.id in next)) {
      next[instance.id] = true;
    }
  }
  selectedInstanceMap.value = next;
}

watch(instances, initializeInstanceMap, { immediate: true });

watch(activeTab, () => {
  if (currentQuery()) {
    runSearch();
  }
});

watch(stateFilter, () => {
  if (currentQuery()) {
    runSearch();
  }
});
</script>

<template>
  <div class="global-search">
    <div class="search-header">
      <h1 class="search-title">{{ t('dashboard.search.title') }}</h1>
      <p class="search-description">{{ t('dashboard.search.description') }}</p>
      <div class="search-controls">
        <vscode-textfield
          :value="query"
          @input="query = ($event.target as HTMLInputElement).value"
          class="search-input"
          :placeholder="t('dashboard.search.placeholder')"
          @keydown="handleInputKeydown"
        />
        <vscode-button icon="search" @click="runSearch">
          {{ t('dashboard.search.searchButton') }}
        </vscode-button>
      </div>
      <div class="filters">
        <div class="filter-group">
          <span class="filter-label">{{ t('dashboard.search.instanceFilter') }}</span>
          <div class="instance-checkboxes">
            <label class="instance-checkbox">
              <input v-model="allInstancesSelected" type="checkbox" />
              <span>{{ t('dashboard.search.allInstances') }}</span>
            </label>
            <label v-for="instance in instances" :key="instance.id" class="instance-checkbox">
              <input v-model="selectedInstanceMap[instance.id]" type="checkbox" />
              <span :title="instance.url">{{ instance.url }} · {{ instance.username }}</span>
            </label>
          </div>
        </div>
        <div v-if="isStateFilterVisible()" class="filter-group">
          <label for="state-filter" class="filter-label">{{ t('dashboard.search.stateFilter') }}</label>
          <p class="filter-description">{{ t('dashboard.search.stateFilterDescription') }}</p>
          <select id="state-filter" v-model="stateFilter" class="state-filter-select">
            <option value="open">{{ t('dashboard.state.open') }}</option>
            <option value="closed">{{ t('dashboard.state.closed') }}</option>
            <option value="all">{{ t('dashboard.state.all') }}</option>
          </select>
        </div>
      </div>
    </div>

    <ViewTabs
      v-model="activeTab"
      :tabs="[
        { key: 'all', label: t('dashboard.search.tabs.all') },
        { key: 'repositories', label: t('dashboard.tabs.repositories') },
        { key: 'issues', label: t('dashboard.tabs.issues') },
        { key: 'pullRequests', label: t('dashboard.tabs.pullRequests') },
      ]"
    />

    <div v-if="instances.length === 0" class="empty-state">
      {{ t('dashboard.search.noInstances') }}
    </div>

    <div v-else-if="!currentQuery() && !hasQueried()" class="empty-state">
      {{ t('dashboard.search.hint') }}
    </div>

    <div v-else-if="isLoading() && !hasResults()" class="empty-state">
      <vscode-progress-ring class="search-loading-ring" />
      {{ t('dashboard.loading') }}
    </div>

    <div v-else-if="hasQueried() && !hasResults() && !isLoading()" class="empty-state">
      {{ t('dashboard.search.noResults') }}
    </div>

    <div v-else class="results">
      <vscode-tree v-for="instance in visibleInstances()" :key="instance.id" indent-guides="onHover">
        <vscode-tree-item branch open>
          {{ instance.url }} · {{ instance.username }}
          <template v-if="errors.get(searchKey(instance.id))">
            <vscode-tree-item>
              <span class="error">{{ formatError(instance.id) }}</span>
              <vscode-icon
                name="refresh"
                action-icon
                :size="16"
                :title="t('dashboard.retry')"
                :aria-label="t('dashboard.retry')"
                @click.stop.prevent="runSearch()"
              />
            </vscode-tree-item>
          </template>
          <template v-else-if="resultFor(instance.id)">
            <!-- Repositories -->
            <template
              v-if="
                (activeTab === 'all' || activeTab === 'repositories') && resultFor(instance.id)!.repositories.length
              "
            >
              <vscode-tree-item v-if="activeTab === 'all'" branch open>
                {{ t('dashboard.tabs.repositories') }}
                <vscode-tree-item
                  v-for="repo in resultFor(instance.id)!.repositories"
                  :key="`repo-${repo.id}`"
                  @click.capture="openRepo($event, instance.id, repo)"
                >
                  <span class="result-title">{{ repo.full_name }}</span>
                  <span v-if="repo.description" class="result-meta" slot="description">{{ repo.description }}</span>
                  <span slot="actions" class="tree-actions">
                    <vscode-icon
                      name="link-external"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.open')"
                      :aria-label="t('dashboard.actions.open')"
                      @click.prevent="state.openExternal(repo.html_url)"
                    />
                    <vscode-icon
                      name="copy"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.copyClone')"
                      :aria-label="t('dashboard.actions.copyClone')"
                      @click.prevent="state.copyToClipboard(repoCloneUrl(instance, repo))"
                    />
                  </span>
                </vscode-tree-item>
              </vscode-tree-item>
              <vscode-tree-item
                v-for="repo in resultFor(instance.id)!.repositories"
                v-else
                :key="`repo-${repo.id}`"
                @click.capture="openRepo($event, instance.id, repo)"
              >
                <span class="result-title">{{ repo.full_name }}</span>
                <span v-if="repo.description" class="result-meta" slot="description">{{ repo.description }}</span>
                <span slot="actions" class="tree-actions">
                  <vscode-icon
                    name="link-external"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.open')"
                    :aria-label="t('dashboard.actions.open')"
                    @click.prevent="state.openExternal(repo.html_url)"
                  />
                  <vscode-icon
                    name="copy"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.copyClone')"
                    :aria-label="t('dashboard.actions.copyClone')"
                    @click.prevent="state.copyToClipboard(repoCloneUrl(instance, repo))"
                  />
                </span>
              </vscode-tree-item>
            </template>

            <!-- Issues -->
            <template v-if="(activeTab === 'all' || activeTab === 'issues') && resultFor(instance.id)!.issues.length">
              <vscode-tree-item v-if="activeTab === 'all'" branch open>
                {{ t('dashboard.tabs.issues') }}
                <vscode-tree-item
                  v-for="issue in resultFor(instance.id)!.issues"
                  :key="`issue-${issue.id}`"
                  @click.capture="openIssue($event, instance.id, issue)"
                >
                  <span class="result-title">#{{ issue.number }} {{ issue.title }}</span>
                  <span class="result-meta" slot="description">{{ issue.state }}</span>
                  <span slot="actions" class="tree-actions">
                    <vscode-icon
                      name="link-external"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.open')"
                      :aria-label="t('dashboard.actions.open')"
                      @click.prevent="state.openExternal(issue.html_url)"
                    />
                    <vscode-icon
                      name="copy"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.copyUrl')"
                      :aria-label="t('dashboard.actions.copyUrl')"
                      @click.prevent="state.copyToClipboard(issue.html_url)"
                    />
                  </span>
                </vscode-tree-item>
              </vscode-tree-item>
              <vscode-tree-item
                v-for="issue in resultFor(instance.id)!.issues"
                v-else
                :key="`issue-${issue.id}`"
                @click.capture="openIssue($event, instance.id, issue)"
              >
                <span class="result-title">#{{ issue.number }} {{ issue.title }}</span>
                <span class="result-meta" slot="description">{{ issue.state }}</span>
                <span slot="actions" class="tree-actions">
                  <vscode-icon
                    name="link-external"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.open')"
                    :aria-label="t('dashboard.actions.open')"
                    @click.prevent="state.openExternal(issue.html_url)"
                  />
                  <vscode-icon
                    name="copy"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.copyUrl')"
                    :aria-label="t('dashboard.actions.copyUrl')"
                    @click.prevent="state.copyToClipboard(issue.html_url)"
                  />
                </span>
              </vscode-tree-item>
            </template>

            <!-- Pull Requests -->
            <template
              v-if="
                (activeTab === 'all' || activeTab === 'pullRequests') && resultFor(instance.id)!.pullRequests.length
              "
            >
              <vscode-tree-item v-if="activeTab === 'all'" branch open>
                {{ t('dashboard.tabs.pullRequests') }}
                <vscode-tree-item
                  v-for="pr in resultFor(instance.id)!.pullRequests"
                  :key="`pr-${pr.id}`"
                  @click.capture="openPullRequest($event, instance.id, pr)"
                >
                  <span class="result-title">#{{ pr.number }} {{ pr.title }}</span>
                  <span class="result-meta" slot="description">{{ pr.state }}</span>
                  <span slot="actions" class="tree-actions">
                    <vscode-icon
                      name="link-external"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.open')"
                      :aria-label="t('dashboard.actions.open')"
                      @click.prevent="state.openExternal(pr.html_url)"
                    />
                    <vscode-icon
                      name="copy"
                      action-icon
                      :size="16"
                      :title="t('dashboard.actions.copyUrl')"
                      :aria-label="t('dashboard.actions.copyUrl')"
                      @click.prevent="state.copyToClipboard(pr.html_url)"
                    />
                  </span>
                </vscode-tree-item>
              </vscode-tree-item>
              <vscode-tree-item
                v-for="pr in resultFor(instance.id)!.pullRequests"
                v-else
                :key="`pr-${pr.id}`"
                @click.capture="openPullRequest($event, instance.id, pr)"
              >
                <span class="result-title">#{{ pr.number }} {{ pr.title }}</span>
                <span class="result-meta" slot="description">{{ pr.state }}</span>
                <span slot="actions" class="tree-actions">
                  <vscode-icon
                    name="link-external"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.open')"
                    :aria-label="t('dashboard.actions.open')"
                    @click.prevent="state.openExternal(pr.html_url)"
                  />
                  <vscode-icon
                    name="copy"
                    action-icon
                    :size="16"
                    :title="t('dashboard.actions.copyUrl')"
                    :aria-label="t('dashboard.actions.copyUrl')"
                    @click.prevent="state.copyToClipboard(pr.html_url)"
                  />
                </span>
              </vscode-tree-item>
            </template>
          </template>
        </vscode-tree-item>
      </vscode-tree>
    </div>
  </div>
</template>

<style scoped>
.global-search {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
}

.search-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 8px;
}

.search-title {
  margin: 0;
  font-size: 1.1em;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.search-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.search-input {
  flex: 1;
  min-width: 0;
}

.search-description {
  margin: 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-label {
  font-size: 0.85em;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.filter-description {
  margin: 0;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}

.instance-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.instance-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85em;
  color: var(--vscode-foreground);
  cursor: pointer;
}

.instance-checkbox span {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-filter-select {
  background-color: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  padding: 4px 8px;
  font-size: 0.85em;
  max-width: 200px;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--vscode-descriptionForeground);
  flex-direction: column;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 8px;
}

.result-title {
  font-size: 0.9em;
}

.result-meta {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.tree-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.search-loading-ring {
  width: 16px;
  height: 16px;
}
</style>
