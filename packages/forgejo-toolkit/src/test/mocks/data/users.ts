import type { ForgejoUser } from '../../../api/types';

export const mockUser: ForgejoUser = {
  id: 1,
  login: 'demo-user',
  full_name: 'Demo User',
  email: 'demo@example.com',
  avatar_url: 'https://forgejo.example.com/avatars/1',
};

export const mockOtherUser: ForgejoUser = {
  id: 2,
  login: 'other-user',
  full_name: 'Other User',
  email: 'other@example.com',
  avatar_url: 'https://forgejo.example.com/avatars/2',
};
