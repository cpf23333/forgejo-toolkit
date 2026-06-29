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
          :open="expandedInstances.has(instance.id)"
          @toggle="handleToggle(instance.id, $event)"
        >
          <div slot="heading" class="instance-header">
            <span>{{ instance.name }}</span>
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
                <div class="item-title">
                  <a href="#" @click.prevent="openRepo(instance.id, repo)">{{ repo.full_name }}</a>
                </div>
                <div v-if="repo.description" class="item-desc">{{ repo.description }}</div>
                <div class="item-meta">
                  <span>{{ t('dashboard.branch') }}: {{ repo.default_branch }}</span>
                  <span>{{ t('dashboard.stars') }}: {{ repo.stars_count }}</span>
                  <span>{{ t('dashboard.forks') }}: {{ repo.forks_count }}</span>
                </div>
                <div class="item-actions">
                  <vscode-button variant="secondary" @click="emit('openExternal', repo.html_url)">{{
                    t('dashboard.actions.open')
                  }}</vscode-button>
                  <vscode-button variant="secondary" @click="emit('copyToClipboard', cloneUrl(instance, repo))">{{
                    t('dashboard.actions.copyClone')
                  }}</vscode-button>
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
                </div>
                <div class="item-meta">
                  <span>{{ issue.state }}</span>
                  <span v-if="issue.repository">{{ issue.repository.full_name }}</span>
                </div>
                <div class="item-actions">
                  <vscode-button variant="secondary" @click="emit('copyToClipboard', issue.html_url)">{{
                    t('dashboard.actions.copyUrl')
                  }}</vscode-button>
                </div>
              </div>
              <div v-if="!myIssues.get(instance.id)?.length" class="empty-list">{{ t('dashboard.noIssues') }}</div>
            </div>
            <div v-else-if="activeTab === 'pullRequests'" class="item-list">
              <div v-for="pr in myPullRequests.get(instance.id)" :key="pr.id" class="item-card">
                <div class="item-title">
                  <a href="#" @click.prevent="emit('openExternal', pr.html_url)">#{{ pr.number }} {{ pr.title }}</a>
                </div>
                <div class="item-meta">
                  <span>{{ pr.state }}</span>
                </div>
                <div class="item-actions">
                  <vscode-button variant="secondary" @click="emit('copyToClipboard', pr.html_url)">{{
                    t('dashboard.actions.copyUrl')
                  }}</vscode-button>
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
  gap: 8px;
}

.badge {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 0.75em;
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

.repo-card {
  cursor: default;
}
</style>
