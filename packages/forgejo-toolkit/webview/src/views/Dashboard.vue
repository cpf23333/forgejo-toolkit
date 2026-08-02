<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import { vscode } from '../composables/vscode';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import DashboardInstanceItem from '../components/DashboardInstanceItem.vue';

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

function setTab(tab: Tab) {
  state.setDashboardActiveTab(tab);
}

const instances = computed(() => state.instances.value);
const linkedRepository = computed(() => state.linkedRepository.value);
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
            <VscodeButton
              appearance="secondary"
              icon="repo"
              :title="t('dashboard.linkedRepository.openRepo')"
              @click="state.openLinkedRepositoryDetail()"
            >
              {{ t('dashboard.linkedRepository.openRepo') }}
            </VscodeButton>
            <VscodeButton
              appearance="secondary"
              icon="issues"
              :title="t('dashboard.linkedRepository.openIssues')"
              @click="state.openLinkedRepositoryIssues()"
            >
              {{ t('dashboard.linkedRepository.openIssues') }}
            </VscodeButton>
            <VscodeButton
              appearance="secondary"
              icon="git-pull-request"
              :title="t('dashboard.linkedRepository.openPullRequests')"
              @click="state.openLinkedRepositoryPullRequests()"
            >
              {{ t('dashboard.linkedRepository.openPullRequests') }}
            </VscodeButton>
          </div>
        </div>
      </div>

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

.dashboard-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.linked-repo-card {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 12px;
}

.linked-repo-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  text-transform: uppercase;
  letter-spacing: 0.025em;
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

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 0 12px 8px;
}

.tab-button {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.9em;
  border-radius: 4px;
  transition: background-color 0.15s ease;
}

.tab-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.tab-button.active {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.instances {
  padding: 0 12px;
}
</style>
