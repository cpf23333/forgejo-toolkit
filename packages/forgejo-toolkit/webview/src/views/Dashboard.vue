<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance, ForgejoRepository, ForgejoIssue, ForgejoPullRequest } from '../types/instance';

const { t } = useI18n();

type Tab = 'repositories' | 'issues' | 'pullRequests';

const props = defineProps<{
  instances: ForgejoInstance[];
  repositories: Map<string, ForgejoRepository[]>;
  myIssues: Map<string, ForgejoIssue[]>;
  myPullRequests: Map<string, ForgejoPullRequest[]>;
  loading: Map<string, boolean>;
  errors: Map<string, string>;
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
  (e: 'copyToClipboard', text: string): void;
  (e: 'openRepo', instanceId: string, owner: string, repo: string): void;
  (e: 'loadRepositories', instanceId: string): void;
  (e: 'loadMyIssues', instanceId: string): void;
  (e: 'loadMyPullRequests', instanceId: string): void;
}>();

const activeTab = ref<Tab>('repositories');
const expandedInstances = ref<Set<string>>(new Set());

function setTab(tab: Tab) {
  activeTab.value = tab;
}

function expandInstance(instanceId: string) {
  if (expandedInstances.value.has(instanceId)) {
    return;
  }
  expandedInstances.value.add(instanceId);
  nextTick(() => {
    loadForTab(instanceId);
  });
}

function collapseInstance(instanceId: string) {
  expandedInstances.value.delete(instanceId);
}

function handleToggle(instanceId: string, event: Event) {
  const customEvent = event as CustomEvent<boolean>;
  if (customEvent.detail) {
    expandInstance(instanceId);
  } else {
    collapseInstance(instanceId);
  }
}

function loadForTab(instanceId: string) {
  if (activeTab.value === 'repositories') {
    emit('loadRepositories', instanceId);
  } else if (activeTab.value === 'issues') {
    emit('loadMyIssues', instanceId);
  } else {
    emit('loadMyPullRequests', instanceId);
  }
}

watch(activeTab, () => {
  expandedInstances.value.forEach((id) => loadForTab(id));
});

watch(
  () => props.instances,
  (newInstances) => {
    if (newInstances.length > 0 && expandedInstances.value.size === 0) {
      expandInstance(newInstances[0].id);
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (props.instances.length > 0 && expandedInstances.value.size === 0) {
    expandInstance(props.instances[0].id);
  }
});

function openRepo(instanceId: string, repo: ForgejoRepository) {
  emit('openRepo', instanceId, repo.owner.login, repo.name);
}

function cloneUrl(instance: ForgejoInstance, repo: ForgejoRepository): string {
  return `${instance.url}/${repo.full_name}.git`;
}

function formatError(key: string): string {
  return t('dashboard.error', { message: props.errors.get(key) ?? '' });
}

function repoCount(instanceId: string): number {
  return props.repositories.get(instanceId)?.length ?? 0;
}

function issueCount(instanceId: string): number {
  return props.myIssues.get(instanceId)?.length ?? 0;
}

function prCount(instanceId: string): number {
  return props.myPullRequests.get(instanceId)?.length ?? 0;
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
</script>

<template>
  <div class="dashboard">
    <div v-if="instances.length === 0" class="empty">
      <p>{{ t('dashboard.emptyTitle') }}</p>
      <p>{{ t('dashboard.emptyHint', { button: t('dashboard.settings') }) }}</p>
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
        <vscode-collapsible
          v-for="instance in instances"
          :key="instance.id"
          :heading="instance.url + ' · ' + instance.username"
          :open="expandedInstances.has(instance.id)"
          @toggle="handleToggle(instance.id, $event)"
        >
          <div slot="decorations" class="instance-header">
            <span class="badge">{{ badgeCount(instance.id) }}</span>
          </div>

          <div class="instance-body">
            <div v-if="loading.get(loadingKey(instance.id))" class="loading">
              {{ t('dashboard.loading') }}
            </div>
            <div v-else-if="errors.get(loadingKey(instance.id))" class="error">
              {{ formatError(loadingKey(instance.id)) }}
            </div>
            <div v-else-if="activeTab === 'repositories'" class="item-list">
              <div v-for="repo in repositories.get(instance.id)" :key="repo.id" class="item-card repo-card">
                <div class="item-title repo-title">
                  <a href="#" @click.prevent="openRepo(instance.id, repo)">{{ repo.full_name }}</a>
                  <span class="repo-actions">
                    <a
                      href="#"
                      :title="t('dashboard.actions.open')"
                      @click.prevent="emit('openExternal', repo.html_url)"
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
                      @click.prevent="emit('copyToClipboard', cloneUrl(instance, repo))"
                    >
                      <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                        />
                      </svg>
                    </a>
                  </span>
                </div>
                <div v-if="repo.description" class="item-desc">{{ repo.description }}</div>
                <div class="item-meta">
                  <span>{{ t('dashboard.branch') }}: {{ repo.default_branch }}</span>
                  <span>{{ t('dashboard.stars') }}: {{ repo.stars_count }}</span>
                  <span>{{ t('dashboard.forks') }}: {{ repo.forks_count }}</span>
                </div>
              </div>
              <div v-if="!repositories.get(instance.id)?.length" class="empty-list">
                {{ t('dashboard.noRepositories') }}
              </div>
            </div>
            <div v-else-if="activeTab === 'issues'" class="item-list">
              <div v-for="issue in myIssues.get(instance.id)" :key="issue.id" class="item-card">
                <div class="item-title">
                  <a href="#" @click.prevent="emit('openExternal', issue.html_url)"
                    >#{{ issue.number }} {{ issue.title }}</a
                  >
                  <span class="issue-actions">
                    <a
                      href="#"
                      :title="t('dashboard.actions.copyUrl')"
                      @click.prevent="emit('copyToClipboard', issue.html_url)"
                    >
                      <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                        />
                      </svg>
                    </a>
                  </span>
                </div>
                <div class="item-meta">
                  <span>{{ issue.state }}</span>
                  <span v-if="issue.repository">{{ issue.repository.full_name }}</span>
                </div>
              </div>
              <div v-if="!myIssues.get(instance.id)?.length" class="empty-list">{{ t('dashboard.noIssues') }}</div>
            </div>
            <div v-else-if="activeTab === 'pullRequests'" class="item-list">
              <div v-for="pr in myPullRequests.get(instance.id)" :key="pr.id" class="item-card">
                <div class="item-title">
                  <a href="#" @click.prevent="emit('openExternal', pr.html_url)">#{{ pr.number }} {{ pr.title }}</a>
                  <span class="pr-actions">
                    <a
                      href="#"
                      :title="t('dashboard.actions.copyUrl')"
                      @click.prevent="emit('copyToClipboard', pr.html_url)"
                    >
                      <svg class="icon-copy" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path
                          d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                        />
                      </svg>
                    </a>
                  </span>
                </div>
                <div class="item-meta">
                  <span>{{ pr.state }}</span>
                </div>
              </div>
              <div v-if="!myPullRequests.get(instance.id)?.length" class="empty-list">
                {{ t('dashboard.noPullRequests') }}
              </div>
            </div>
          </div>
        </vscode-collapsible>
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

.instances {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.instance-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.instance-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.instance-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.instance-detail {
  font-size: 0.75em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 0.75em;
  flex-shrink: 0;
}

.instance-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}

.loading {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 12px 0;
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 10px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.item-title {
  font-weight: 600;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.repo-title {
  justify-content: space-between;
}

.repo-actions,
.issue-actions,
.pr-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.repo-actions a,
.issue-actions a,
.pr-actions a {
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  padding: 2px;
}

.repo-actions a:hover,
.issue-actions a:hover,
.pr-actions a:hover {
  color: var(--vscode-textLink-foreground);
}

.repo-actions a svg,
.issue-actions a svg,
.pr-actions a svg {
  width: 14px;
  height: 14px;
  display: block;
}

.item-title a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.item-title a:hover {
  text-decoration: underline;
}

.item-desc {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 6px;
}

.item-meta {
  display: flex;
  gap: 12px;
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 8px;
}

.item-actions {
  display: flex;
  gap: 8px;
}

.item-actions a {
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  padding: 2px;
}

.item-actions a:hover {
  color: var(--vscode-textLink-foreground);
}

.repo-card {
  cursor: default;
}
</style>
