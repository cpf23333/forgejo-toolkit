import { ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance } from '../types/instance';
import { vscode } from './vscode';
import type { Locale } from '../i18n';
import type {
  ForgejoRepository,
  ForgejoIssue,
  ForgejoPullRequest,
  ForgejoRepoDetail,
  ForgejoIssueDetail,
  ForgejoPullRequestDetail,
} from '../types/api';

export type Page = 'dashboard' | 'repoDetail' | 'issueDetail' | 'pullRequestDetail' | 'settings';

export function useAppState() {
  const { t, locale } = useI18n();

  const instances = ref<ForgejoInstance[]>([]);
  const currentPage = ref<Page>('dashboard');

  const repositories = ref<Map<string, ForgejoRepository[]>>(new Map());
  const myIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const myPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const repoDetails = ref<Map<string, ForgejoRepoDetail>>(new Map());
  const issueDetails = ref<Map<string, ForgejoIssueDetail>>(new Map());
  const pullRequestDetails = ref<Map<string, ForgejoPullRequestDetail>>(new Map());
  const loading = ref<Map<string, boolean>>(new Map());
  const errors = ref<Map<string, string>>(new Map());

  const selectedRepo = ref<{ instanceId: string; owner: string; repo: string } | null>(null);
  const selectedIssue = ref<{ instanceId: string; owner: string; repo: string; index: number } | null>(null);
  const selectedPullRequest = ref<{ instanceId: string; owner: string; repo: string; index: number } | null>(null);

  const debug = ref<boolean>(false);

  function handleMessage(event: MessageEvent) {
    const message = event.data;
    switch (message.command) {
      case 'instances':
        instances.value = message.data ?? [];
        break;
      case 'openSettings':
        currentPage.value = 'settings';
        break;
      case 'setLocale':
        if (typeof message.locale === 'string') {
          locale.value = message.locale;
        }
        break;
      case 'setDebug':
        if (typeof message.debug === 'boolean') {
          debug.value = message.debug;
        }
        break;
      case 'repositories':
        handleRepositories(message.data);
        break;
      case 'myIssues':
        handleMyIssues(message.data);
        break;
      case 'myPullRequests':
        handleMyPullRequests(message.data);
        break;
      case 'repoDetail':
        handleRepoDetail(message.data);
        break;
      case 'issueDetail':
        handleIssueDetail(message.data);
        break;
      case 'pullRequestDetail':
        handlePullRequestDetail(message.data);
        break;
    }
  }

  function handleRepositories(data: { instanceId: string; repositories?: ForgejoRepository[]; error?: string }) {
    const key = `repos-${data.instanceId}`;
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      repositories.value.set(data.instanceId, data.repositories ?? []);
    }
  }

  function handleMyIssues(data: { instanceId: string; issues?: ForgejoIssue[]; error?: string }) {
    const key = `issues-${data.instanceId}`;
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      myIssues.value.set(data.instanceId, data.issues ?? []);
    }
  }

  function handleMyPullRequests(data: { instanceId: string; pullRequests?: ForgejoPullRequest[]; error?: string }) {
    const key = `pulls-${data.instanceId}`;
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      myPullRequests.value.set(data.instanceId, data.pullRequests ?? []);
    }
  }

  function handleRepoDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    detail?: ForgejoRepoDetail;
    error?: string;
  }) {
    const key = repoDetailKey(data.instanceId, data.owner, data.repo);
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else if (data.detail) {
      errors.value.delete(key);
      repoDetails.value.set(key, data.detail);
    }
  }

  function handleIssueDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoIssueDetail;
    error?: string;
  }) {
    const key = issueDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else if (data.detail) {
      errors.value.delete(key);
      issueDetails.value.set(key, data.detail);
    }
  }

  function handlePullRequestDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoPullRequestDetail;
    error?: string;
  }) {
    const key = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else if (data.detail) {
      errors.value.delete(key);
      pullRequestDetails.value.set(key, data.detail);
    }
  }

  onMounted(() => {
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ command: 'getInstances' });
    vscode.postMessage({ command: 'getLocale' });
  });

  onUnmounted(() => {
    window.removeEventListener('message', handleMessage);
  });

  function openExternal(url: string) {
    vscode.postMessage({ command: 'openExternal', url });
  }

  function copyToClipboard(text: string) {
    vscode.postMessage({ command: 'copyToClipboard', text });
  }

  function previewReadme(content: string) {
    if (!selectedRepo.value) {
      return;
    }
    vscode.postMessage({
      command: 'previewReadme',
      owner: selectedRepo.value.owner,
      repo: selectedRepo.value.repo,
      content,
    });
  }

  function testConnection(url: string, token: string) {
    vscode.postMessage({ command: 'testConnection', url, token });
  }

  function saveInstance(url: string, token: string) {
    vscode.postMessage({ command: 'saveInstance', url, token });
  }

  function removeInstance(id: string) {
    vscode.postMessage({ command: 'removeInstance', id });
  }

  function changeLocale(newLocale: Locale) {
    locale.value = newLocale;
    vscode.postMessage({ command: 'setLocale', locale: newLocale });
  }

  function changeDebug(newDebug: boolean) {
    debug.value = newDebug;
    vscode.postMessage({ command: 'setDebug', debug: newDebug });
  }

  function backToDashboard() {
    currentPage.value = 'dashboard';
    selectedRepo.value = null;
    selectedIssue.value = null;
    selectedPullRequest.value = null;
  }

  function openRepoDetail(instanceId: string, owner: string, repo: string) {
    selectedRepo.value = { instanceId, owner, repo };
    selectedIssue.value = null;
    selectedPullRequest.value = null;
    currentPage.value = 'repoDetail';
    const key = repoDetailKey(instanceId, owner, repo);
    if (!repoDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getRepoDetail', instanceId, owner, repo });
    }
  }

  function openIssueDetail(instanceId: string, owner: string, repo: string, index: number) {
    selectedIssue.value = { instanceId, owner, repo, index };
    selectedRepo.value = null;
    selectedPullRequest.value = null;
    currentPage.value = 'issueDetail';
    const key = issueDetailKey(instanceId, owner, repo, index);
    if (!issueDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getIssueDetail', instanceId, owner, repo, index });
    }
  }

  function openPullRequestDetail(instanceId: string, owner: string, repo: string, index: number) {
    selectedPullRequest.value = { instanceId, owner, repo, index };
    selectedRepo.value = null;
    selectedIssue.value = null;
    currentPage.value = 'pullRequestDetail';
    const key = pullRequestDetailKey(instanceId, owner, repo, index);
    if (!pullRequestDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getPullRequestDetail', instanceId, owner, repo, index });
    }
  }

  function loadRepositories(instanceId: string) {
    const key = `repos-${instanceId}`;
    if (loading.value.get(key)) {
      return;
    }
    loading.value.set(key, true);
    vscode.postMessage({ command: 'getRepositories', instanceId });
  }

  function loadMyIssues(instanceId: string, state = 'open') {
    const key = `issues-${instanceId}`;
    if (loading.value.get(key)) {
      return;
    }
    loading.value.set(key, true);
    vscode.postMessage({ command: 'getMyIssues', instanceId, state });
  }

  function loadMyPullRequests(instanceId: string, state = 'open') {
    const key = `pulls-${instanceId}`;
    if (loading.value.get(key)) {
      return;
    }
    loading.value.set(key, true);
    vscode.postMessage({ command: 'getMyPullRequests', instanceId, state });
  }

  return {
    t,
    locale,
    instances,
    currentPage,
    repositories,
    myIssues,
    myPullRequests,
    repoDetails,
    issueDetails,
    pullRequestDetails,
    loading,
    errors,
    selectedRepo,
    selectedIssue,
    selectedPullRequest,
    debug,
    openExternal,
    copyToClipboard,
    previewReadme,
    testConnection,
    saveInstance,
    removeInstance,
    changeLocale,
    changeDebug,
    backToDashboard,
    openRepoDetail,
    openIssueDetail,
    openPullRequestDetail,
    loadRepositories,
    loadMyIssues,
    loadMyPullRequests,
  };
}

export function repoDetailKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}`;
}

export function issueDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}`;
}

export function pullRequestDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}`;
}
