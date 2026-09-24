/**
 * Tracks uploads that are still in flight.
 *
 * The edit forms render the uploaded image inline only when the request
 * returns: EasyMDE inserts `![image](url)` into the editor from the upload's
 * success callback. A save issued while that request is still running
 * therefore serialises a body that predates the image, and the markdown the
 * user just inserted never reaches the server — the form's own save and the
 * upload are two independent round-trips.
 *
 * Both the editor's image picker and the attachment list register their
 * request here, and the submit handlers await `waitForIdle()` before building
 * the payload, so the saved body always contains what is on screen.
 */
export interface PendingUploads {
  /** Register an upload that has just been kicked off; returns its handle. */
  begin(): symbol;
  /** Mark the upload behind `handle` as finished (success or failure). */
  end(handle: symbol): void;
  /** Resolves once every upload registered so far has finished. */
  waitForIdle(): Promise<void>;
  /** Whether at least one upload is still in flight. */
  isPending(): boolean;
}

export function createPendingUploads(): PendingUploads {
  const inFlight = new Map<symbol, Promise<void>>();
  const resolvers = new Map<symbol, () => void>();

  return {
    begin(): symbol {
      const handle = Symbol('upload');
      let resolve!: () => void;
      const settled = new Promise<void>((res) => {
        resolve = res;
      });
      inFlight.set(handle, settled);
      resolvers.set(handle, resolve);
      return handle;
    },
    end(handle: symbol): void {
      // Keyed by handle, so out-of-order completions (two images picked in a
      // row) each end exactly their own upload instead of the oldest one.
      const settled = inFlight.get(handle);
      if (!settled) {
        return;
      }
      // Deleting before resolving keeps `isPending()` from reporting a settled
      // upload that simply has not been collected yet.
      inFlight.delete(handle);
      resolvers.get(handle)?.();
      resolvers.delete(handle);
    },
    async waitForIdle(): Promise<void> {
      // The snapshot is re-read after each await: an upload the user starts
      // while the submit handler is already waiting must be waited for too.
      let pending = [...inFlight.values()];
      while (pending.length > 0) {
        await Promise.allSettled(pending);
        pending = [...inFlight.values()];
      }
    },
    isPending(): boolean {
      return inFlight.size > 0;
    },
  };
}
