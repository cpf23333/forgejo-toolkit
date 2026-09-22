import type { ForgejoBranch, ForgejoRelease, ForgejoTag } from '../../../api/types';

export const mockBranch: ForgejoBranch = {
  name: 'feature/new-stuff',
  commit: { sha: 'feature-sha' },
  protected: false,
} as ForgejoBranch;

export const mockTag: ForgejoTag = {
  name: 'v2.0.0',
  commit: { sha: 'tag-sha' },
  tarball_url: 'https://forgejo.example.com/demo-user/demo-repo/archive/v2.0.0.tar.gz',
  zipball_url: 'https://forgejo.example.com/demo-user/demo-repo/archive/v2.0.0.zip',
} as ForgejoTag;

// Defined before the release so the release can carry it as an asset: the
// release edit dialog only offers the delete action for attachments the release
// actually lists, and without one the destructive-confirmation walkthrough had
// nothing to click.
export const mockReleaseAttachment = {
  id: 10,
  uuid: 'release-attachment-uuid',
  name: 'release-notes.md',
  size: 256,
  browser_download_url: 'https://forgejo.example.com/demo-user/demo-repo/releases/download/v2.0.0/release-notes.md',
};

export const mockRelease: ForgejoRelease = {
  id: 5,
  tag_name: 'v2.0.0',
  name: 'Version 2.0.0',
  body: 'Release notes',
  draft: false,
  prerelease: false,
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/releases/5',
  target_commitish: 'main',
  assets: [mockReleaseAttachment],
} as ForgejoRelease;
