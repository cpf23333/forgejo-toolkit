<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAppState } from '../composables/useAppState';
import { postMessage } from '../composables/vscode';
import DashboardInstanceItem from '../components/DashboardInstanceItem.vue';
import ViewTabs from '../components/ViewTabs.vue';

const { t } = useI18n();
const state = useAppState();
const router = useRouter();

function openOnboarding() {
  postMessage({ command: 'openOnboardingPanel' });
}

function openSearch() {
  router.push({ name: 'globalSearch' });
}

function openNotifications() {
  router.push({ name: 'notifications' });
}

type Tab = 'repositories' | 'issues' | 'pullRequests';

const activeTab = computed<Tab>({
  get: () => state.dashboardActiveTab.value,
  set: (tab) => state.setDashboardActiveTab(tab),
});

const instances = computed(() => state.instances.value);
const linkedRepository = computed(() => state.linkedRepository.value);
</script>

<template>
  <div class="dashboard">
    <div v-if="instances.length === 0" class="empty">
      <p>{{ t('dashboard.emptyTitle') }}</p>
      <p>{{ t('dashboard.emptyHint', { button: t('dashboard.openOnboarding') }) }}</p>
      <vscode-button @click="openOnboarding">
        {{ t('dashboard.openOnboarding') }}
      </vscode-button>
    </div>

    <div v-else class="dashboard-content">
      <div v-if="linkedRepository" class="linked-repo-card">
        <div class="linked-repo-main">
          <div class="linked-repo-info">
            <div class="linked-repo-title-row">
              <span class="linked-repo-title">{{ t('dashboard.linkedRepository.title') }}</span>
              <span class="linked-repo-path" :title="linkedRepository.localPath">{{ linkedRepository.localPath }}</span>
            </div>
            <span class="linked-repo-name">{{ linkedRepository.owner }}/{{ linkedRepository.repo }}</span>
            <span class="linked-repo-instance">{{ linkedRepository.remoteUrl }}</span>
          </div>
          <div class="linked-repo-actions">
            <vscode-button
              icon="repo"
              :title="t('dashboard.linkedRepository.openRepo')"
              @click="state.openLinkedRepositoryDetail()"
              secondary
            >
              {{ t('dashboard.linkedRepository.openRepo') }}
            </vscode-button>
            <vscode-button
              icon="issues"
              :title="t('dashboard.linkedRepository.openIssues')"
              @click="state.openLinkedRepositoryIssues()"
              secondary
            >
              {{ t('dashboard.linkedRepository.openIssues') }}
            </vscode-button>
            <vscode-button
              icon="git-pull-request"
              :title="t('dashboard.linkedRepository.openPullRequests')"
              @click="state.openLinkedRepositoryPullRequests()"
              secondary
            >
              {{ t('dashboard.linkedRepository.openPullRequests') }}
            </vscode-button>
          </div>
        </div>
      </div>

      <div class="dashboard-toolbar">
        <ViewTabs
          v-model="activeTab"
          class="dashboard-tabs"
          :tabs="[
            { key: 'repositories', label: t('dashboard.tabs.repositories') },
            { key: 'issues', label: t('dashboard.tabs.issues') },
            { key: 'pullRequests', label: t('dashboard.tabs.pullRequests') },
          ]"
        />
        <div class="dashboard-toolbar-actions">
          <vscode-button
            icon="bell"
            :title="t('dashboard.notifications.title')"
            :aria-label="t('dashboard.notifications.title')"
            @click="openNotifications"
            secondary
          >
            <span class="button-label">{{ t('dashboard.notifications.title') }}</span>
            <span v-if="state.unreadNotificationCount.value > 0" class="notification-badge">
              {{ state.unreadNotificationCount.value }}
            </span>
          </vscode-button>
          <vscode-button
            icon="search"
            :title="t('dashboard.search.title')"
            :aria-label="t('dashboard.search.title')"
            @click="openSearch"
            secondary
          >
            <span class="button-label">{{ t('dashboard.search.searchButton') }}</span>
          </vscode-button>
        </div>
      </div>

      <div class="instances">
        <vscode-tree indent-guides="onHover">
          <DashboardInstanceItem
            v-for="(instance, index) in instances"
            :key="instance.id"
            :instance="instance"
            :active-tab="activeTab"
            :auto-expand="index === 0"
          />
        </vscode-tree>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
}

.empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--vscode-descriptionForeground);
}

.empty p {
  margin: 8px 0;
}

.dashboard-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.linked-repo-card {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 10px 8px;
}

.linked-repo-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.linked-repo-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.linked-repo-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.linked-repo-title {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  font-weight: 600;
}

.linked-repo-path {
  color: var(--vscode-descriptionForeground);
  font-size: 0.8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.linked-repo-name {
  color: var(--vscode-textLink-foreground);
  font-size: 1.15em;
  font-weight: 600;
}

.linked-repo-instance {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.linked-repo-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.dashboard-toolbar {
  container-type: inline-size;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px;
}

.dashboard-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

@container (max-width: 360px) {
  .dashboard-toolbar-actions :deep(.button-label) {
    display: none;
  }
}

.dashboard-tabs {
  flex: 1;
  min-width: 0;
}

.notification-badge {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 10px;
  padding: 2px 6px;
  font-size: 0.75em;
  margin-left: 4px;
}

.view-tabs {
  padding: 0 8px;
}

.instances {
  padding: 0 8px;
}
</style>
