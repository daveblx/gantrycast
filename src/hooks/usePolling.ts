import { useEffect, useRef } from 'react';

/**
 * Run an async task on an interval without overlapping runs.
 *
 * Uses a chained timeout rather than setInterval so a slow request can never
 * stack up behind the next tick. Pauses while the document is hidden and
 * fires immediately when it becomes visible again.
 */
export function usePolling(
  task: () => Promise<void> | void,
  intervalMs: number,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: number | undefined;
    let running = false;

    function schedule() {
      if (cancelled) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, intervalMs);
    }

    async function run() {
      // A single chain only: a run that is still in flight owns the next
      // schedule, so a visibility change can never fork a second chain.
      if (cancelled || running) return;
      running = true;
      if (document.visibilityState === 'visible') {
        try {
          await taskRef.current();
        } catch {
          /* callers surface their own errors */
        }
      }
      running = false;
      schedule();
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      if (running) return;
      window.clearTimeout(timer);
      void run();
    };

    void run();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);
}
