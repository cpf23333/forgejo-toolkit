export interface ForgejoUser {
    id: number;
    login: string;
    full_name: string;
    email: string;
    avatar_url: string;
}

export interface ForgejoRepository {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    private: boolean;
    description: string;
}

export interface ForgejoIssue {
    id: number;
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: ForgejoUser;
    body: string;
    created_at: string;
    updated_at: string;
}

export interface ForgejoPullRequest {
    id: number;
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: ForgejoUser;
    body: string;
    created_at: string;
    updated_at: string;
}
