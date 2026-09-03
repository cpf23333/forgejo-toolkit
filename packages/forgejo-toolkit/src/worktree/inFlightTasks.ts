/**
 * Deduplicates concurrent async operations by key: while a task for a key is
 * still running, additional runs for the same key reuse its promise instead of
 * starting a new task (e.g. double-clicking "open PR worktree" must not fetch
 * the same branch or `git worktree add` the same path twice).
 */
export class InFlightTasks {
  private readonly tasks = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.tasks.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    let taskPromise: Promise<T>;
    try {
      taskPromise = task();
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    const promise = taskPromise.finally(() => {
      this.tasks.delete(key);
    });
    this.tasks.set(key, promise);
    return promise;
  }
}
