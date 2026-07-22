import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
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

export function useAppState() {
  const router = useRouter();
  const { t, locale } = useI18n();

  const instances = ref<ForgejoInstance[]>([]);

  const repositories = ref<Map<string, ForgejoRepository[]>>(new Map());
  const myIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const myPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const repoDetails = ref<Map<string, ForgejoRepoDetail>>(new Map());
  const issueDetails = ref<Map<string, ForgejoIssueDetail>>(new Map());
  const pullRequestDetails = ref<Map<string, ForgejoPullRequestDetail>>(new Map());
  const repoIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const repoPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const renderedMarkdown = ref<Map<string, string>>(new Map());
  const loading = ref<Map<string, boolean>>(new Map());
  const errors = ref<Map<string, string>>(new Map());

  const debug = ref<boolean>(false);
  let renderMarkdownRequestId = 0;
  const pendingRenderMarkdownRequests = new Map<
    string,
    { resolve: (html: string) => void; reject: (error: Error) => void }
  >();

  function handleMessage(event: MessageEvent) {
    const message = event.data;
    switch (message.command) {
      case 'instances':
        instances.value = message.data ?? [];
        break;
      case 'openSettings':
        router.push({ name: 'settings' });
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
      case 'repoIssues':
        handleRepoIssues(message.data);
        break;
      case 'repoPullRequests':
        handleRepoPullRequests(message.data);
        break;
      case 'renderedMarkdown':
        handleRenderedMarkdown(message.data);
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

  function handleRepoIssues(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    issues?: ForgejoIssue[];
    error?: string;
  }) {
    const key = repoIssuesKey(data.instanceId, data.owner, data.repo, data.state);
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      repoIssues.value.set(key, data.issues ?? []);
    }
  }

  function handleRepoPullRequests(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const key = repoPullRequestsKey(data.instanceId, data.owner, data.repo, data.state);
    loading.value.set(key, false);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      repoPullRequests.value.set(key, data.pullRequests ?? []);
    }
  }

  function handleRenderedMarkdown(data: { key: string; html?: string; error?: string }) {
    const pending = pendingRenderMarkdownRequests.get(data.key);
    if (!pending) {
      return;
    }
    pendingRenderMarkdownRequests.delete(data.key);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      renderedMarkdown.value.set(data.key, data.html ?? '');
      pending.resolve(data.html ?? '');
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

  function previewReadme(owner: string, repo: string, content: string) {
    vscode.postMessage({ command: 'previewReadme', owner, repo, content });
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

  function openRepoDetail(instanceId: string, owner: string, repo: string) {
    router.push({ name: 'repoDetail', params: { instanceId, owner, repo } });
    const key = repoDetailKey(instanceId, owner, repo);
    if (!repoDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getRepoDetail', instanceId, owner, repo });
    }
  }

  function openIssueDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'issueDetail', params: { instanceId, owner, repo, index: String(index) } });
    const key = issueDetailKey(instanceId, owner, repo, index);
    if (!issueDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getIssueDetail', instanceId, owner, repo, index });
    }
  }

  function openPullRequestDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'pullRequestDetail', params: { instanceId, owner, repo, index: String(index) } });
    const key = pullRequestDetailKey(instanceId, owner, repo, index);
    if (!pullRequestDetails.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getPullRequestDetail', instanceId, owner, repo, index });
    }
  }

  function openRepoIssues(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoIssues', params: { instanceId, owner, repo, state } });
    const key = repoIssuesKey(instanceId, owner, repo, state);
    if (!repoIssues.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getRepoIssues', instanceId, owner, repo, state });
    }
  }

  function openRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoPullRequests', params: { instanceId, owner, repo, state } });
    const key = repoPullRequestsKey(instanceId, owner, repo, state);
    if (!repoPullRequests.value.has(key)) {
      loading.value.set(key, true);
      vscode.postMessage({ command: 'getRepoPullRequests', instanceId, owner, repo, state });
    }
  }

  function changeRepoIssuesState(instanceId: string, owner: string, repo: string, newState: string) {
    openRepoIssues(instanceId, owner, repo, newState);
  }

  function changeRepoPullRequestsState(instanceId: string, owner: string, repo: string, newState: string) {
    openRepoPullRequests(instanceId, owner, repo, newState);
  }

  function renderMarkdown(instanceId: string, text: string, context?: string): Promise<string> {
    const key = `render-${++renderMarkdownRequestId}`;
    return new Promise((resolve, reject) => {
      pendingRenderMarkdownRequests.set(key, { resolve, reject });
      vscode.postMessage({ command: 'renderMarkdown', instanceId, text, context, key });
    });
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
    repositories,
    myIssues,
    myPullRequests,
    repoDetails,
    issueDetails,
    pullRequestDetails,
    repoIssues,
    repoPullRequests,
    loading,
    errors,
    debug,
    openExternal,
    copyToClipboard,
    previewReadme,
    testConnection,
    saveInstance,
    removeInstance,
    changeLocale,
    changeDebug,
    openRepoDetail,
    openIssueDetail,
    openPullRequestDetail,
    openRepoIssues,
    openRepoPullRequests,
    changeRepoIssuesState,
    changeRepoPullRequestsState,
    renderMarkdown,
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

export function repoIssuesKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:issues:${state}`;
}

export function repoPullRequestsKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:pulls:${state}`;
}
