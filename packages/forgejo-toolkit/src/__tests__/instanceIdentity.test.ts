import { describe, expect, it } from 'vitest';
import { instanceIdFor, instanceNameFor, resolveInstanceIdCollision } from '../instanceIdentity';

describe('instanceIdFor', () => {
  it('keeps the plain host-login id for a root path URL', () => {
    // Existing installations must not be re-keyed: the token secret is stored
    // under this id.
    expect(instanceIdFor('https://forgejo.example.com', 'demo-user')).toBe('forgejo.example.com-demo-user');
    expect(instanceIdFor('https://forgejo.example.com/', 'demo-user')).toBe('forgejo.example.com-demo-user');
  });

  it('appends a path slug so two instances on one host no longer collide', () => {
    const first = instanceIdFor('https://forgejo.example.com/a', 'demo-user');
    const second = instanceIdFor('https://forgejo.example.com/b', 'demo-user');
    expect(first).toBe('forgejo.example.com-a-demo-user');
    expect(second).toBe('forgejo.example.com-b-demo-user');
    expect(first).not.toBe(second);
    // A trailing slash is the same instance.
    expect(instanceIdFor('https://forgejo.example.com/a/', 'demo-user')).toBe(first);
  });

  it('keeps the port and normalizes multi-segment paths', () => {
    expect(instanceIdFor('https://forgejo.example.com:3004/x/y', 'demo-user')).toBe(
      'forgejo.example.com:3004-x-y-demo-user',
    );
  });

  it('falls back to a path hash when the path slugs to nothing', () => {
    // A path of separator characters only has no letters or digits to keep, so
    // `/_` and `/--` would otherwise share one `forgejo.example.com--demo-user`
    // id and overwrite each other.
    const first = instanceIdFor('https://forgejo.example.com/_', 'demo-user');
    const second = instanceIdFor('https://forgejo.example.com/--', 'demo-user');
    expect(first).toMatch(/^forgejo\.example\.com-[0-9a-f]{8}-demo-user$/);
    expect(second).toMatch(/^forgejo\.example\.com-[0-9a-f]{8}-demo-user$/);
    expect(first).not.toBe(second);
    // Stable across calls, and a trailing slash is still the same instance.
    expect(instanceIdFor('https://forgejo.example.com/_/', 'demo-user')).toBe(first);
  });
});

describe('resolveInstanceIdCollision', () => {
  it('keeps the id when nothing stored conflicts with it', () => {
    expect(resolveInstanceIdCollision('host-user', 'https://host', [])).toBe('host-user');
    // A stored entry with the same id and the same URL is the same instance:
    // re-adding it (e.g. re-import) must keep updating in place.
    expect(resolveInstanceIdCollision('host-user', 'https://host', [{ id: 'host-user', url: 'https://host' }])).toBe(
      'host-user',
    );
  });

  it('treats a trailing slash as the same instance, not a collision', () => {
    // `https://host` and `https://host/` name the same server; a character-exact
    // compare would fork a fresh id for a mere spelling difference.
    const existing = [{ id: 'host-user', url: 'https://host' }];
    expect(resolveInstanceIdCollision('host-user', 'https://host/', existing)).toBe('host-user');
    expect(resolveInstanceIdCollision('host-user', 'https://host', [{ id: 'host-user', url: 'https://host/' }])).toBe(
      'host-user',
    );
    // A genuinely different URL still collides, slashes or not.
    expect(resolveInstanceIdCollision('host-user', 'https://host/a', existing)).not.toBe('host-user');
  });

  it('derives a deterministic fresh id when the id is taken by another URL', () => {
    const existing = [{ id: 'host-a-b-user', url: 'https://host/a-b' }];
    const derived = resolveInstanceIdCollision('host-a-b-user', 'https://host/a/b', existing);
    expect(derived).toMatch(/^host-a-b-user-[0-9a-f]{8}$/);
    expect(resolveInstanceIdCollision('host-a-b-user', 'https://host/a/b', existing)).toBe(derived);
  });

  it('keeps deriving when the derived id is itself taken by another URL', () => {
    // An entry genuinely stored under the derived id must not be overwritten
    // either; the attempt salt moves the derivation to yet another id.
    const existing = [{ id: 'host-a-b-user', url: 'https://host/a-b' }];
    const derived = resolveInstanceIdCollision('host-a-b-user', 'https://host/a/b', existing);
    const blocked = [...existing, { id: derived, url: 'https://host/a/c' }];
    const second = resolveInstanceIdCollision('host-a-b-user', 'https://host/a/b', blocked);
    expect(second).not.toBe(derived);
    expect(second).toMatch(/^host-a-b-user-[0-9a-f]{8}$/);
  });
});

describe('instanceNameFor', () => {
  it('renders login@host plus the sub-path, without a trailing slash', () => {
    expect(instanceNameFor('https://forgejo.example.com', 'demo-user')).toBe('demo-user@forgejo.example.com');
    expect(instanceNameFor('https://forgejo.example.com/', 'demo-user')).toBe('demo-user@forgejo.example.com');
    expect(instanceNameFor('https://forgejo.example.com/a/', 'demo-user')).toBe('demo-user@forgejo.example.com/a');
    expect(instanceNameFor('https://forgejo.example.com:3004/x/y', 'demo-user')).toBe(
      'demo-user@forgejo.example.com:3004/x/y',
    );
  });

  it('produces the same name for the same instance however it is spelled', () => {
    // `name` is part of the webview's instance cache identity, so a save and an
    // edit of the same URL must not produce two different names: editing an
    // instance without changing anything would otherwise drop its cached data.
    expect(instanceNameFor('https://forgejo.example.com/a', 'demo-user')).toBe(
      instanceNameFor('https://forgejo.example.com/a/', 'demo-user'),
    );
  });
});
