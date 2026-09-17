import { createRouter, createMemoryHistory } from 'vue-router';

// All views are lazy-loaded so the initial bundle only contains the shell;
// each view (and its transitive imports such as the markdown editor) becomes
// its own chunk fetched on first navigation.
const Dashboard = () => import('../views/Dashboard.vue');
const GlobalSearch = () => import('../views/GlobalSearch.vue');
const ImportPreview = () => import('../views/ImportPreview.vue');
const Notifications = () => import('../views/Notifications.vue');
const RepoDetail = () => import('../views/RepoDetail.vue');
const RepoIssues = () => import('../views/RepoIssues.vue');
const RepoPullRequests = () => import('../views/RepoPullRequests.vue');
const IssueDetail = () => import('../views/IssueDetail.vue');
const PullRequestDetail = () => import('../views/PullRequestDetail.vue');
const ActionRunDetail = () => import('../views/ActionRunDetail.vue');
const Settings = () => import('../views/Settings.vue');

export const routes = [
  { path: '/', component: Dashboard, name: 'dashboard' },
  { path: '/search', component: GlobalSearch, name: 'globalSearch' },
  { path: '/import-preview', component: ImportPreview, name: 'importPreview' },
  { path: '/notifications', component: Notifications, name: 'notifications' },
  { path: '/repo/:instanceId/:owner/:repo', component: RepoDetail, name: 'repoDetail' },
  {
    path: '/repo/:instanceId/:owner/:repo/issues/:state?',
    component: RepoIssues,
    name: 'repoIssues',
  },
  {
    path: '/repo/:instanceId/:owner/:repo/pulls/:state?',
    component: RepoPullRequests,
    name: 'repoPullRequests',
  },
  {
    path: '/issue/:instanceId/:owner/:repo/:index',
    component: IssueDetail,
    name: 'issueDetail',
  },
  {
    path: '/pull/:instanceId/:owner/:repo/:index',
    component: PullRequestDetail,
    name: 'pullRequestDetail',
  },
  {
    path: '/repo/:instanceId/:owner/:repo/actions/runs/:runId',
    component: ActionRunDetail,
    name: 'actionRunDetail',
  },
  { path: '/settings', component: Settings, name: 'settings' },
];

export function createAppRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  });
}
