import { describe, expect, it } from 'vitest';
import { instanceIdFor } from '../instanceIdentity';

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
});
