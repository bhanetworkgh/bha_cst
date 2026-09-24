/**
 * DbClient — Disconnect Lifecycle Tests
 *
 *   D1 — disconnect() when no pool is active → resolves without throwing
 *   D2 — disconnect() is idempotent: second call resolves without error
 *   D3 — clearInMemory() clears all in-memory stores without touching the pool
 *   D4 — setPool() + disconnect() ends the pool and nulls the reference
 *   D5 — after disconnect(), getPool() returns null (pool is cleared)
 */
import { describe, it, expect, vi } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';

describe('DbClient — Disconnect Lifecycle', () => {
  // D1 — no pool: disconnect() is a no-op
  it('D1: disconnect() when no pool is active resolves without throwing', async () => {
    expect(DbClient.getPool()).toBeNull();
    await expect(DbClient.disconnect()).resolves.toBeUndefined();
  });

  // D2 — idempotent: second disconnect() after the first is safe
  it('D2: disconnect() is idempotent — second call is safe', async () => {
    await DbClient.disconnect();
    await expect(DbClient.disconnect()).resolves.toBeUndefined();
  });

  // D3 — clearInMemory() clears stores but does not affect the pool pointer
  it('D3: clearInMemory() clears in-memory stores without touching pool', async () => {
    DbClient.seedCustomer({
      tenant_id: 'tenant-test',
      phone_e164: '+15550001111',
      customer_ref: 'cust_test_001',
    });
    expect(DbClient.lookupCustomerByPhone('+15550001111', 'tenant-test')).not.toBeNull();

    DbClient.clearInMemory();

    expect(DbClient.lookupCustomerByPhone('+15550001111', 'tenant-test')).toBeNull();
    expect(DbClient.getPool()).toBeNull();
  });

  // D4 — setPool() + disconnect() ends the injected mock pool
  it('D4: setPool(mockPool) then disconnect() calls pool.end()', async () => {
    const endSpy = vi.fn().mockResolvedValue(undefined);
    const mockPool = { end: endSpy } as any;

    DbClient.setPool(mockPool);
    expect(DbClient.getPool()).toBe(mockPool);

    await DbClient.disconnect();

    expect(endSpy).toHaveBeenCalledOnce();
  });

  // D5 — after disconnect(), getPool() returns null
  it('D5: after disconnect() the pool reference is null', async () => {
    const endSpy = vi.fn().mockResolvedValue(undefined);
    DbClient.setPool({ end: endSpy } as any);

    await DbClient.disconnect();

    expect(DbClient.getPool()).toBeNull();
  });
});
