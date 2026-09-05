/**
 * Process-level backstops for the chat service.
 *
 * Node ends the process on an unhandled rejection, and Compose restarts it — so one floating
 * promise in a best-effort path (a presence write, a metric, a log shipper) becomes a crash loop
 * for as long as its dependency is away, while everything the service is actually for keeps
 * working right up to the moment it is killed. The first heartbeat after Valkey became unreachable
 * did exactly that.
 *
 * Every such call site still carries its own `catch` — this is the floor under the ones nobody has
 * written yet, not a licence to stop writing them. It deliberately does not swallow
 * `uncaughtException`: an exception that escaped a synchronous stack leaves state nobody can
 * reason about, and there the restart is the right answer.
 */

export interface GuardLogger {
  error(obj: Record<string, unknown>, msg: string): void
}

/**
 * Log unhandled rejections instead of dying of them. Returns a function that removes the handler
 * again, which is what a test uses to leave the process as it found it.
 */
export function installUnhandledRejectionGuard(log: GuardLogger): () => void {
  const onRejection = (reason: unknown) => {
    log.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandled promise rejection; the service kept running',
    )
  }
  process.on('unhandledRejection', onRejection)
  return () => {
    process.off('unhandledRejection', onRejection)
  }
}
