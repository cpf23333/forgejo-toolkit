import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForgejoClient } from '../../api/client';
import { mockContentFilePaths, mockContentFileTexts, mockContentListings } from './data';
import { resetMockServer, startMockServer, stopMockServer } from './server';

// The contents endpoint is the one place where the fixture tree is *implicit*:
// the handlers answer a path because the listings declare it. These tests keep
// that contract — a path the tree does not carry must be a 404, and a directory
// must answer its children (an earlier catch-all answered a file for any path,
// which made the client's directory guard and its 404 handling untestable).
describe('Mock contents endpoint', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  function createClient(): ForgejoClient {
    return new ForgejoClient('https://forgejo.example.com', 'mock-token');
  }

  it('gives every directory entry a listing of its own', () => {
    const withoutListing = Object.values(mockContentListings)
      .flat()
      .filter((entry) => entry.type === 'dir')
      .map((entry) => entry.path ?? '')
      .filter((path) => !mockContentListings[path]);
    // A `dir` entry whose path answers 404 advertises a directory nothing can
    // open, which is exactly the kind of hole the old catch-all hid.
    expect(withoutListing).toEqual([]);
  });

  it('answers a directory with its children instead of a file', async () => {
    const entries = await createClient().getRepoContents('demo-user', 'demo-repo', 'src');
    expect(entries.map((entry) => entry.path)).toEqual(['src/index.ts', 'src/utils']);

    // The same path through the file reader must say "this is a directory",
    // not report a file with generated content.
    await expect(createClient().getFileContent('demo-user', 'demo-repo', 'src')).resolves.toContain('is a directory');
  });

  it('serves every file the tree advertises', async () => {
    for (const path of mockContentFilePaths) {
      await expect(createClient().getFileContent('demo-user', 'demo-repo', path)).resolves.not.toBe('');
    }
  });

  it('agrees with the listings about a file size', async () => {
    const root = await createClient().getRepoContents('demo-user', 'demo-repo', '');
    const packageEntry = root.find((entry) => entry.path === 'package.json');
    expect(packageEntry?.size).toBe(mockContentFileTexts['package.json']?.length);

    const content = await createClient().getFileContent('demo-user', 'demo-repo', 'package.json');
    expect(content.length).toBe(packageEntry?.size);
  });

  it('carries no payload in a listing', async () => {
    const root = await createClient().getRepoContents('demo-user', 'demo-repo', '');
    expect(root.every((entry) => entry.content === undefined)).toBe(true);
  });

  it('echoes the requested ref into a generated placeholder', async () => {
    const content = await createClient().getFileContent('demo-user', 'demo-repo', 'docs/guide.md', 'dev');
    expect(content).toContain('docs/guide.md');
    expect(content).toContain('ref: dev');
  });

  it('answers 404 for a path outside the fixture tree', async () => {
    await expect(createClient().getFileContent('demo-user', 'demo-repo', 'does/not/exist.ts')).rejects.toMatchObject({
      status: 404,
    });
    await expect(createClient().getRepoContents('demo-user', 'demo-repo', 'missing')).rejects.toMatchObject({
      status: 404,
    });
  });
});
