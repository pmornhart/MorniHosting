/**
 * Runs jobs for the same key one after another (e.g. Geyser and voice chat on one server: both change the
 * server's ports, at the same time one would overwrite the other). Jobs for different keys run side by side.
 */
const queues = new Map<string, Promise<unknown>>();

export function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(job);
  queues.set(key, next);
  // Clean up either way; this side branch must not raise the job's error a second time.
  const clear = (): void => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(clear, clear);
  return next;
}
