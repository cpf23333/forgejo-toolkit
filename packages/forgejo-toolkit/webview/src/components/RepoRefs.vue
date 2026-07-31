<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState, repoRefsKey } from '../composables/useAppState';

const props = defineProps<{
  instanceId: string;
  owner: string;
  repo: string;
}>();

const { t } = useI18n();
const state = useAppState();

const activeTab = ref<'branches' | 'tags' | 'releases'>('branches');
const tabs: Array<{ key: 'branches' | 'tags' | 'releases'; label: string }> = [
  { key: 'branches', label: t('dashboard.repoRefs.branches') },
  { key: 'tags', label: t('dashboard.repoRefs.tags') },
  { key: 'releases', label: t('dashboard.repoRefs.releases') },
];

const key = computed(() => repoRefsKey(props.instanceId, props.owner, props.repo));
const data = computed(() => state.repoRefs.value.get(key.value));
const loading = computed(() => state.loading.value.get(key.value) ?? false);
const error = computed(() => state.errors.value.get(key.value));

watch(
  () => [props.instanceId, props.owner, props.repo],
  () => {
    state.loadRepoRefs(props.instanceId, props.owner, props.repo);
  },
  { immediate: true },
);

function formatDate(date: string): string {
  try {
    return new Date(date).toLocaleDateString();
  } catch {
    return date;
  }
}
</script>

<template>
  <div class="repo-refs">
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-button"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="loading" class="status">{{ t('dashboard.loading') }}</div>
    <div v-else-if="error" class="status error">{{ error }}</div>

    <template v-else>
      <div v-if="activeTab === 'branches'" class="ref-list">
        <div v-for="branch in data?.branches" :key="branch.name" class="ref-item">
          <div class="ref-main">
            <span class="ref-name">{{ branch.name }}</span>
            <span v-if="branch.protected" class="badge protected">{{ t('dashboard.repoRefs.protected') }}</span>
          </div>
          <div v-if="branch.commit?.message" class="ref-meta">
            {{ branch.commit.message.split('\n')[0] }}
          </div>
        </div>
        <div v-if="!data?.branches.length" class="status">{{ t('dashboard.repoRefs.emptyBranches') }}</div>
      </div>

      <div v-if="activeTab === 'tags'" class="ref-list">
        <div v-for="tag in data?.tags" :key="tag.name" class="ref-item">
          <div class="ref-main">
            <span class="ref-name">{{ tag.name }}</span>
          </div>
          <div v-if="tag.commit?.sha" class="ref-meta">
            {{ tag.commit.sha.slice(0, 7) }}
          </div>
        </div>
        <div v-if="!data?.tags.length" class="status">{{ t('dashboard.repoRefs.emptyTags') }}</div>
      </div>

      <div v-if="activeTab === 'releases'" class="ref-list">
        <div v-for="release in data?.releases" :key="release.id" class="ref-item">
          <div class="ref-main">
            <span class="ref-name">{{ release.name || release.tag_name }}</span>
            <span v-if="release.prerelease" class="badge prerelease">{{ t('dashboard.repoRefs.prerelease') }}</span>
            <span v-else-if="release.draft" class="badge draft">{{ t('dashboard.repoRefs.draft') }}</span>
          </div>
          <div class="ref-meta">
            <span v-if="release.tag_name">{{ release.tag_name }}</span>
            <span v-if="release.published_at">{{ formatDate(release.published_at) }}</span>
          </div>
        </div>
        <div v-if="!data?.releases.length" class="status">{{ t('dashboard.repoRefs.emptyReleases') }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.repo-refs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tab-button {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vscode-foreground);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.95em;
  border-radius: 0;
}

.tab-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.tab-button.active {
  color: var(--vscode-textLink-foreground);
  border-bottom-color: var(--vscode-textLink-foreground);
}

.ref-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ref-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 4px;
}

.ref-item:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}

.ref-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ref-name {
  font-weight: 600;
  color: var(--vscode-foreground);
}

.ref-meta {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 8px;
}

.badge {
  font-size: 0.75em;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}

.badge.protected {
  background-color: var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
  color: #fff;
}

.badge.prerelease {
  background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  color: #000;
}

.badge.draft {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.status {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 8px 0;
}

.status.error {
  color: var(--vscode-testing-iconFailed);
}
</style>
