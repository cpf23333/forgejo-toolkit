import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance } from '../types/instance';
import '../types/config';
import { vscode } from './vscode';

const vscodeVersion = window.__FORGEJO_TOOLKIT_CONFIG__?.vscodeVersion ?? '';
import type { Locale } from '../i18n';
import type {
  ForgejoChangedFile,
  ForgejoRepository,
  ForgejoIssue,
  ForgejoPullRequest,
  ForgejoRepoDetail,
  ForgejoIssueDetail,
  ForgejoPullRequestDetail,
  ForgejoPullRequestWorktreeInfo,
} from '../types/api';

import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

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
  const pullRequestFiles = ref<Map<string, ForgejoChangedFile[]>>(new Map());
  const renderedMarkdown = ref<Map<string, string>>(new Map());
  const loading = ref<Map<string, boolean>>(new Map());
  const errors = ref<Map<string, string>>(new Map());

  const debug = ref<boolean>(false);
  const worktrees = ref<ForgejoPullRequestWorktreeInfo[]>([]);
  const worktreeOpenMode = ref<'currentWindow' | 'newWindow'>('newWindow');
  const worktreeCacheDirectory = ref<string | undefined>(undefined);
  const worktreeCacheDirectoryDefault = ref<string | undefined>(undefined);
  const supportsMultiDiff = computed(() => isVersionAtLeast(vscodeVersion, '1.86.0'));
  const testConnectionResult = ref<{ success: boolean; username?: string; error?: string } | undefined>(undefined);
  const saveInstanceResult = ref<{ success: boolean; error?: string } | undefined>(undefined);
  let renderMarkdownRequestId = 0;
  const pendingRenderMarkdownRequests = new Map<
    string,
    { resolve: (html: string) => void; reject: (error: Error) => void }
  >();

  function handleMessage(event: MessageEvent<HostToWebviewMessage>) {
    const message = event.data;
    switch (message.command) {
      case 'instances':
        instances.value = message.data ?? [];
        break;
      case 'openSettings':
        router.push({ name: 'settings' });
        break;
      case 'openDashboard':
        router.push({ name: 'dashboard' });
        break;
      case 'setLocale':
        locale.value = message.locale;
        break;
      case 'setDebug':
        debug.value = message.debug;
        break;
      case 'repositories':
        handleRepositories(message as { instanceId: string; repositories?: ForgejoRepository[]; error?: string });
        break;
      case 'myIssues':
        handleMyIssues(message as { instanceId: string; issues?: ForgejoIssue[]; error?: string });
        break;
      case 'myPullRequests':
        handleMyPullRequests(message as { instanceId: string; pullRequests?: ForgejoPullRequest[]; error?: string });
        break;
      case 'repoDetail':
        handleRepoDetail(
          message as { instanceId: string; owner: string; repo: string; detail?: ForgejoRepoDetail; error?: string },
        );
        break;
      case 'issueDetail':
        handleIssueDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoIssueDetail;
            error?: string;
          },
        );
        break;
      case 'pullRequestDetail':
        handlePullRequestDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoPullRequestDetail;
            error?: string;
          },
        );
        break;
      case 'pullRequestFiles':
        handlePullRequestFiles(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            files?: ForgejoChangedFile[];
            error?: string;
          },
        );
        break;
      case 'repoIssues':
        handleRepoIssues(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            issues?: ForgejoIssue[];
            error?: string;
          },
        );
        break;
      case 'repoPullRequests':
        handleRepoPullRequests(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            pullRequests?: ForgejoPullRequest[];
            error?: string;
          },
        );
        break;
      case 'renderedMarkdown':
        handleRenderedMarkdown(message as { key: string; html?: string; error?: string });
        break;
      case 'worktreesList':
        worktrees.value = (message.worktrees ?? []) as ForgejoPullRequestWorktreeInfo[];
        break;
      case 'worktreeOpened':
        if (message.worktree) {
          const wt = message.worktree as ForgejoPullRequestWorktreeInfo;
          const list = worktrees.value.filter((w) => w.id !== wt.id);
          list.push(wt);
          worktrees.value = list;
        }
        break;
      case 'worktreeRemoved':
        if (message.id) {
          worktrees.value = worktrees.value.filter((w) => w.id !== message.id);
        }
        break;
      case 'worktreeOpenMode':
        if (message.mode === 'currentWindow' || message.mode === 'newWindow') {
          worktreeOpenMode.value = message.mode;
        }
        break;
      case 'worktreeCacheDirectory':
        worktreeCacheDirectory.value = message.directory;
        worktreeCacheDirectoryDefault.value = message.defaultDirectory;
        break;
      case 'testConnectionResult':
        testConnectionResult.value = message;
        break;
      case 'saveInstanceResult':
        saveInstanceResult.value = message;
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

  function handlePullRequestFiles(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    files?: ForgejoChangedFile[];
    error?: string;
  }) {
    const key = pullRequestFilesKey(data.instanceId, data.owner, data.repo, data.index);
    if (data.error) {
      errors.value.set(key, data.error);
    } else {
      errors.value.delete(key);
      pullRequestFiles.value.set(key, data.files ?? []);
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
    vscode.postMessage({ command: 'getWorktrees' });
    vscode.postMessage({ command: 'getWorktreeOpenMode' });
    vscode.postMessage({ command: 'getWorktreeCacheDirectory' });
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

  function loadPullRequestFiles(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    baseSha?: string,
    headSha?: string,
  ) {
    const key = pullRequestFilesKey(instanceId, owner, repo, index);
    if (pullRequestFiles.value.has(key)) {
      return;
    }
    vscode.postMessage({ command: 'getPullRequestFiles', instanceId, owner, repo, index, baseSha, headSha });
  }

  function openPullRequestDiff(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    filename: string,
    status: string,
    baseSha: string,
    headSha: string,
  ) {
    vscode.postMessage({
      command: 'openPullRequestDiff',
      instanceId,
      owner,
      repo,
      index,
      filename,
      status,
      baseSha,
      headSha,
    });
  }

  function openSelectedPullRequestDiffs(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    files: { filename: string; status: string }[],
    baseSha: string,
    headSha: string,
  ) {
    vscode.postMessage({
      command: 'openSelectedPullRequestDiffs',
      instanceId,
      owner,
      repo,
      index,
      files,
      baseSha,
      headSha,
    });
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

  function openPrWorktree(instanceId: string, owner: string, repo: string, index: number) {
    vscode.postMessage({ command: 'openPrWorktree', instanceId, owner, repo, index });
  }

  function loadWorktrees() {
    vscode.postMessage({ command: 'getWorktrees' });
  }

  function removeWorktree(id: string) {
    vscode.postMessage({ command: 'removeWorktree', id });
  }

  function changeWorktreeOpenMode(mode: 'currentWindow' | 'newWindow') {
    worktreeOpenMode.value = mode;
    vscode.postMessage({ command: 'setWorktreeOpenMode', mode });
  }

  function getWorktreeCacheDirectory() {
    vscode.postMessage({ command: 'getWorktreeCacheDirectory' });
  }

  function setWorktreeCacheDirectory(directory: string) {
    worktreeCacheDirectory.value = directory;
    vscode.postMessage({ command: 'setWorktreeCacheDirectory', directory });
  }

  function browseWorktreeCacheDirectory() {
    vscode.postMessage({ command: 'browseWorktreeCacheDirectory' });
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
    pullRequestFiles,
    loading,
    errors,
    debug,
    worktrees,
    worktreeOpenMode,
    worktreeCacheDirectory,
    worktreeCacheDirectoryDefault,
    vscodeVersion,
    supportsMultiDiff,
    testConnectionResult,
    saveInstanceResult,
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
    loadPullRequestFiles,
    openPullRequestDiff,
    openSelectedPullRequestDiffs,
    openRepoIssues,
    openRepoPullRequests,
    changeRepoIssuesState,
    changeRepoPullRequestsState,
    openPrWorktree,
    loadWorktrees,
    removeWorktree,
    changeWorktreeOpenMode,
    getWorktreeCacheDirectory,
    setWorktreeCacheDirectory,
    browseWorktreeCacheDirectory,
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

export function pullRequestFilesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:files`;
}

export function repoIssuesKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:issues:${state}`;
}

export function repoPullRequestsKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:pulls:${state}`;
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const current = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}
