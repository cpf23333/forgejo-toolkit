import { createRouter, createMemoryHistory } from 'vue-router';
import Dashboard from '../views/Dashboard.vue';
import GlobalSearch from '../views/GlobalSearch.vue';
import ImportPreview from '../views/ImportPreview.vue';
import Notifications from '../views/Notifications.vue';
import RepoDetail from '../views/RepoDetail.vue';
import RepoIssues from '../views/RepoIssues.vue';
import RepoPullRequests from '../views/RepoPullRequests.vue';
import IssueDetail from '../views/IssueDetail.vue';
import PullRequestDetail from '../views/PullRequestDetail.vue';
import ActionRunDetail from '../views/ActionRunDetail.vue';
import Settings from '../views/Settings.vue';

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
