import { describe, expect, it, vi } from 'vitest';

import { InFlightTasks } from '../inFlightTasks';

describe('InFlightTasks', () => {
  it('reuses the in-flight promise for the same key', async () => {
    const lock = new InFlightTasks();
    let resolveTask!: (value: string) => void;
    const task = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTask = resolve;
        }),
    );

    const first = lock.run('pr-1', task);
    const second = lock.run('pr-1', task);

    expect(task).toHaveBeenCalledTimes(1);
    resolveTask('done');
    await expect(first).resolves.toBe('done');
    await expect(second).resolves.toBe('done');
  });

  it('runs separate tasks for different keys', async () => {
    const lock = new InFlightTasks();
    const task = vi.fn(async () => 'done');

    await lock.run('pr-1', task);
    await lock.run('pr-2', task);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('starts a new task after the previous one settles', async () => {
    const lock = new InFlightTasks();
    const task = vi.fn(async () => 'done');

    await lock.run('pr-1', task);
    await lock.run('pr-1', task);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('propagates rejection to all waiters and clears the key', async () => {
    const lock = new InFlightTasks();
    let rejectTask!: (error: Error) => void;
    const failing = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectTask = reject;
        }),
    );

    const first = lock.run('pr-1', failing);
    const second = lock.run('pr-1', failing);
    // Attach handlers before rejecting to avoid unhandled rejection warnings.
    const firstResult = first.catch((error: unknown) => error);
    const secondResult = second.catch((error: unknown) => error);

    rejectTask(new Error('boom'));
    expect(await firstResult).toBeInstanceOf(Error);
    expect(await secondResult).toBeInstanceOf(Error);

    const retry = vi.fn(async () => 'recovered');
    await expect(lock.run('pr-1', retry)).resolves.toBe('recovered');
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
