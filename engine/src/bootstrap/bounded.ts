/**
 * Bounded bootstrap helpers.
 *
 * WHY THIS EXISTS
 *   The service's boot sequence talks to Postgres. `pg` waits indefinitely
 *   for a connection by default, so a slow, restarting or unreachable
 *   database can stall the boot. When that happens the process never binds a
 *   port, which means:
 *
 *     - Twilio callbacks are not answered and time out (error 11203);
 *     - `/health` is not served, so the instance looks dead to Render;
 *     - the outbound queue worker — which starts after the listener — never
 *       runs at all, so queued customer messages are not sent.
 *
 *   These helpers bound that wait so the listener and the worker always come
 *   up, and let the durable bootstrap be retried in the background.
 */
import { Logger } from '../config/logger.js';

/**
 * Run `work` with a hard time bound.
 *
 * @param label  Human-readable name used in the diagnostic messages.
 * @param work   The work to run. A rejection is handled and reported; it is
 *               never allowed to escape as an unhandled rejection.
 * @param timeoutMs  Maximum time to wait.
 * @returns `true` when the work completed successfully inside the window.
 *   `false` when it timed out OR failed — both are retryable, so the caller
 *   can treat them the same way. A rejection never escapes as an unhandled
 *   rejection.
 */
export async function runBounded(
  label: string,
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  const settled = work
    .then(() => 'done' as const)
    .catch((err: any) => {
      Logger.warn(`${label} failed: ${err?.message ?? String(err)}`);
      return 'failed' as const;
    });
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    Logger.warn(
      `${label} did not complete within ${timeoutMs}ms — continuing without it and retrying in the background`,
    );
    return false;
  }
  return outcome === 'done';
}

/**
 * A retryable, idempotent bootstrap step.
 *
 * The first call starts the work. While that attempt is in flight, further
 * calls join it rather than starting a second one. A failed or timed-out
 * attempt clears the in-flight marker so a later call can try again.
 */
export class RetryableBootstrap {
  private attempt: Promise<boolean> | null = null;

  constructor(
    private readonly label: string,
    private readonly steps: Array<(label: string) => Promise<unknown>>,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Run (or join) the bootstrap.
   *
   * @returns `true` when every step completed inside its window.
   */
  run(): Promise<boolean> {
    if (this.attempt) return this.attempt;
    const attempt = (async () => {
      let ok = true;
      for (const step of this.steps) {
        const done = await runBounded(step.name, step(this.label), this.timeoutMs);
        if (!done) {
          ok = false;
          break;
        }
      }
      if (!ok) this.attempt = null;
      return ok;
    })();
    this.attempt = attempt;
    return attempt;
  }
}
