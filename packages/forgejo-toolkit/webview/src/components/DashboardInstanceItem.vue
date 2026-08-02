<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppState } from '../composables/useAppState';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoRepository, ForgejoIssue, ForgejoPullRequest } from '../types/api';

const props = defineProps<{
  instance: ForgejoInstance;
  activeTab: 'repositories' | 'issues' | 'pullRequests';
  autoExpand?: boolean;
}>();

const { t } = useI18n();
const state = useAppState();

const treeItemRef = ref<HTMLElement | undefined>(undefined);
const expandedOwners = ref<Set<string>>(new Set());
let openObserver: MutationObserver | undefined;

const instanceId = computed(() => props.instance.id);
const repositories = computed(() => state.repositories.value.get(instanceId.value));
const myIssues = computed(() => state.myIssues.value.get(instanceId.value));
const myPullRequests = computed(() => state.myPullRequests.value.get(instanceId.value));
const loading = computed(() => state.loading);
const errors = computed(() => state.errors);

function isOpen(el?: HTMLElement): boolean {
  return el?.hasAttribute('open') ?? false;
}

function setOpen(el: HTMLElement, value: boolean) {
  if (value) {
    el.setAttribute('open', '');
  } else {
    el.removeAttribute('open');
  }
}

function handleOpenChange() {
  const el = treeItemRef.value;
  if (!el) {
    return;
  }
  console.log('[DashboardInstanceItem] open attribute changed', instanceId.value, isOpen(el));
  if (isOpen(el)) {
    loadForTab();
    nextTick(() => autoExpandFirstOwner());
  }
}

onMounted(() => {
  const el = treeItemRef.value;
  if (!el) {
    return;
  }
  openObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'open') {
        handleOpenChange();
      }
    }
  });
  openObserver.observe(el, { attributes: true, attributeFilter: ['open'] });
  console.log('[DashboardInstanceItem] observer mounted', instanceId.value, isOpen(el), props.autoExpand);
  if (props.autoExpand && !isOpen(el)) {
    setOpen(el, true);
  } else if (isOpen(el)) {
    handleOpenChange();
  }
  loadForTab();
});

onUnmounted(() => {
  openObserver?.disconnect();
});

function ownerKey(owner: string): string {
  return `${instanceId.value}:${owner}`;
}

function reposByOwner(): Record<string, ForgejoRepository[]> {
  const repos = repositories.value ?? [];
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

function autoExpandFirstOwner() {
  const owners = Object.keys(reposByOwner());
  if (owners.length === 0) {
    return;
  }
  const hasExpandedOwner = Array.from(expandedOwners.value).some((key) => key.startsWith(`${instanceId.value}:`));
  if (!hasExpandedOwner) {
    expandedOwners.value.add(ownerKey(owners[0]));
  }
}

function handleOwnerClick(owner: string) {
  const key = ownerKey(owner);
  if (expandedOwners.value.has(key)) {
    expandedOwners.value.delete(key);
  } else {
    expandedOwners.value.add(key);
  }
}

function dataLoaded(): boolean {
  if (props.activeTab === 'repositories') {
    return state.repositoriesCache.has(instanceId.value);
  }
  if (props.activeTab === 'issues') {
    return state.myIssuesCache.has(instanceId.value);
  }
  return state.myPullRequestsCache.has(instanceId.value);
}

function loadForTab(force = false) {
  console.log('[DashboardInstanceItem] loadForTab', instanceId.value, props.activeTab);
  if (!force && dataLoaded()) {
    return;
  }
  if (props.activeTab === 'repositories') {
    state.loadRepositories(instanceId.value, force);
  } else if (props.activeTab === 'issues') {
    state.loadMyIssues(instanceId.value, 'open', force);
  } else {
    state.loadMyPullRequests(instanceId.value, 'open', force);
  }
}

watch(
  () => props.activeTab,
  () => {
    loadForTab();
  },
);

watch(repositories, () => {
  if (isOpen(treeItemRef.value)) {
    autoExpandFirstOwner();
  }
});

function isActionClick(event: Event): boolean {
  return !!(event.target as HTMLElement).closest('.tree-actions');
}

function openRepo(event: Event, repo: ForgejoRepository) {
  if (isActionClick(event)) {
    return;
  }
  state.openRepoDetail(instanceId.value, repo.owner.login, repo.name);
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

function openIssue(event: Event, issue: ForgejoIssue) {
  if (isActionClick(event)) {
    return;
  }
  const ownerRepo = issue.repository?.full_name
    ? { owner: issue.repository.full_name.split('/')[0], repo: issue.repository.full_name.split('/')[1] }
    : parseOwnerRepo(issue.html_url);
  if (ownerRepo) {
    state.openIssueDetail(instanceId.value, ownerRepo.owner, ownerRepo.repo, issue.number);
  }
}

function openPullRequest(event: Event, pr: ForgejoPullRequest) {
  if (isActionClick(event)) {
    return;
  }
  const ownerRepo = parseOwnerRepo(pr.html_url);
  if (ownerRepo) {
    state.openPullRequestDetail(instanceId.value, ownerRepo.owner, ownerRepo.repo, pr.number);
  }
}

function cloneUrl(repo: ForgejoRepository): string {
  return `${props.instance.url}/${repo.full_name}.git`;
}

function formatError(key: string): string {
  return t('dashboard.error', { message: errors.value.get(key) ?? '' });
}

function badgeCount(): number {
  if (props.activeTab === 'repositories') {
    return repositories.value?.length ?? 0;
  }
  if (props.activeTab === 'issues') {
    return myIssues.value?.length ?? 0;
  }
  return myPullRequests.value?.length ?? 0;
}

function loadingKey(): string {
  if (props.activeTab === 'repositories') {
    return `repos-${instanceId.value}`;
  }
  if (props.activeTab === 'issues') {
    return `issues-${instanceId.value}`;
  }
  return `pulls-${instanceId.value}`;
}
</script>

<template>
  <vscode-tree-item ref="treeItemRef" branch>
    {{ instance.url }} · {{ instance.username }}
    <span class="badge" slot="decoration">{{ badgeCount() }}</span>
    <span slot="description">
      <span v-if="loading.get(loadingKey())" class="loading">
        <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
      </span>
      <span v-else-if="errors.get(loadingKey())" class="error">{{ formatError(loadingKey()) }}</span>
    </span>
    <template v-if="activeTab === 'repositories'">
      <template v-if="loading.get(loadingKey())">
        <vscode-tree-item>
          <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
        </vscode-tree-item>
      </template>
      <template v-else-if="!repositories?.length">
        <vscode-tree-item>{{ t('dashboard.noRepositories') }}</vscode-tree-item>
      </template>
      <template v-else>
        <vscode-tree-item
          v-for="(ownerRepos, owner) in reposByOwner()"
          :key="owner"
          branch
          :open="expandedOwners.has(ownerKey(owner))"
          @click="handleOwnerClick(owner)"
        >
          {{ owner }}
          <span class="badge" slot="decoration">{{ ownerRepos.length }}</span>
          <vscode-tree-item v-for="repo in ownerRepos" :key="repo.id" @click.capture="openRepo($event, repo)">
            <span class="tree-repo-name">{{ repo.name }}</span>
            <span class="tree-repo-meta" slot="description">
              {{ t('dashboard.branch') }}: {{ repo.default_branch }} · {{ t('dashboard.stars') }}:
              {{ repo.stars_count }} · {{ t('dashboard.forks') }}: {{ repo.forks_count }}
            </span>
            <span slot="actions" class="tree-actions">
              <a href="#" :title="t('dashboard.actions.open')" @click.prevent="state.openExternal(repo.html_url)">
                <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path
                    d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                  />
                </svg>
              </a>
              <a
                href="#"
                :title="t('dashboard.actions.copyClone')"
                @click.prevent="state.copyToClipboard(cloneUrl(repo))"
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
      <template v-if="loading.get(loadingKey())">
        <vscode-tree-item>
          <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
        </vscode-tree-item>
      </template>
      <template v-else-if="!myIssues?.length">
        <vscode-tree-item>{{ t('dashboard.noIssues') }}</vscode-tree-item>
      </template>
      <template v-else>
        <vscode-tree-item v-for="issue in myIssues" :key="issue.id" @click.capture="openIssue($event, issue)">
          #{{ issue.number }} {{ issue.title }}
          <span class="tree-issue-meta" slot="description">{{ issue.state }}</span>
          <span slot="actions" class="tree-actions">
            <a href="#" :title="t('dashboard.actions.open')" @click.prevent="state.openExternal(issue.html_url)">
              <svg class="icon-link" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path
                  d="M1.5 1.75a.25.25 0 0 1 .25-.25h6.5a.75.75 0 0 0 0-1.5h-6.5C.786 0 0 .784 0 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0 0 16 14.25v-6.5a.75.75 0 0 0-1.5 0v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V1.75zM12.5 0a.75.75 0 0 0 0 1.5h2.19L6.22 9.97a.75.75 0 1 0 1.06 1.06L15.5 2.56v2.19a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5z"
                />
              </svg>
            </a>
            <a href="#" :title="t('dashboard.actions.copyUrl')" @click.prevent="state.copyToClipboard(issue.html_url)">
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
      <template v-if="loading.get(loadingKey())">
        <vscode-tree-item>
          <vscode-progress-ring class="tab-loading-ring" /> {{ t('dashboard.loading') }}
        </vscode-tree-item>
      </template>
      <template v-else-if="!myPullRequests?.length">
        <vscode-tree-item>{{ t('dashboard.noPullRequests') }}</vscode-tree-item>
      </template>
      <template v-else>
        <vscode-tree-item v-for="pr in myPullRequests" :key="pr.id" @click.capture="openPullRequest($event, pr)">
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
            <a href="#" :title="t('dashboard.actions.copyUrl')" @click.prevent="state.copyToClipboard(pr.html_url)">
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
</template>

<style scoped>
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
</style>
