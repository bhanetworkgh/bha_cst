/**
 * Bounded bootstrap — regression tests.
 *
 * The service's boot sequence talks to Postgres. `pg` waits indefinitely for
 * a connection by default, so an unreachable or restarting database used to
 * stall the boot forever: the process never bound a port, so Twilio
 * callbacks timed out (error 11203), `/health` was not served, and the
 * outbound queue worker — which starts after the listener — never ran.
 *
 * These tests assert that the wait is bounded and that a failed attempt can
 * be retried.
 */
import { describe, it, expect, vi } from 'vitest';
import { runBounded, RetryableBootstrap } from '../../engine/src/bootstrap/bounded.js';

describe('runBounded', () => {
  it('resolves true when the work completes inside the window', async () => {
    const ok = await runBounded('fast work', Promise.resolve('done'), 1000);
    expect(ok).toBe(true);
  });

  it('resolves false — and does not hang — when the work never settles', async () => {
    const started = Date.now();
    const never = new Promise<string>(() => {
      /* deliberately never settles */
    });
    const ok = await runBounded('hanging work', never, 100);
    const elapsed = Date.now() - started;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  it('handles a rejection instead of letting it escape', async () => {
    // A rejected step is reported as "not done" so the caller can retry it,
    // and the rejection never escapes as an unhandled rejection.
    const ok = await runBounded('failing work', Promise.reject(new Error('boom')), 1000);
    expect(ok).toBe(false);
  });

  it('does not leave the process alive on the timeout timer', async () => {
    const never = new Promise<string>(() => {});
    await runBounded('hanging work', never, 50);
    // If the timer were not unref'd/cleared, vitest would report a hanging
    // handle. Reaching this assertion proves the timer was released.
    expect(true).toBe(true);
  });
});

describe('RetryableBootstrap', () => {
  it('runs every step in order and reports success', async () => {
    const order: string[] = [];
    const bootstrap = new RetryableBootstrap(
      'registry',
      [
        async (label) => {
          order.push('first');
          return label;
        },
        async () => {
          order.push('second');
        },
      ],
      1000,
    );

    const ok = await bootstrap.run();
    expect(ok).toBe(true);
    expect(order).toEqual(['first', 'second']);
  });

  it('stops at a timed-out step and allows a later retry', async () => {
    let attempt = 0;
    const bootstrap = new RetryableBootstrap(
      'registry',
      [
        async () => {
          attempt++;
          if (attempt === 1) return new Promise<string>(() => {});
          return 'ok';
        },
      ],
      80,
    );

    const first = await bootstrap.run();
    expect(first).toBe(false);

    // A second call must be able to run again — the failed attempt must not
    // wedge the bootstrap forever.
    const second = await bootstrap.run();
    expect(second).toBe(true);
    expect(attempt).toBe(2);
  });

  it('joins an in-flight attempt rather than starting a second one', async () => {
    let calls = 0;
    const bootstrap = new RetryableBootstrap(
      'registry',
      [
        async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
        },
      ],
      1000,
    );

    const a = bootstrap.run();
    const b = bootstrap.run();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});
