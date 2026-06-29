import type { ForgejoIssue, ForgejoPullRequest, ForgejoUser } from './types';

export class ForgejoClient {
    constructor(
        private url: string,
        private token: string
    ) {}

    async getCurrentUser(): Promise<ForgejoUser> {
        return this.request('/user');
    }

    async getUserIssues(state: string = 'open'): Promise<ForgejoIssue[]> {
        return this.request(`/user/issues?state=${encodeURIComponent(state)}`);
    }

    async getRepoIssues(owner: string, repo: string, state: string = 'open'): Promise<ForgejoIssue[]> {
        return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state)}`);
    }

    async getRepoPulls(owner: string, repo: string, state: string = 'open'): Promise<ForgejoPullRequest[]> {
        return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${encodeURIComponent(state)}`);
    }

    private async request(path: string): Promise<any> {
        const baseUrl = this.url.replace(/\/$/, '');
        const url = `${baseUrl}/api/v1${path}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${this.token}`,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Forgejo API error ${response.status}: ${text || response.statusText}`);
        }

        return response.json();
    }
}
