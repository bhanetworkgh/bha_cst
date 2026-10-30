/**
 * Regression tests for security-ledger persistence via Logger.audit() and
 * DbClient.recordSecurityLedgerEvent().
 *
 * These tests verify the in-memory behavior (no database required).
 * Fire-and-forget DB persistence is exercised through the dynamic import
 * path in Logger.audit().
 *
 * No live Twilio, no database, no customer data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, type SecurityLedgerEvent } from '../../engine/src/config/logger.js';
import { DbClient } from '../../engine/src/db/client.js';

const baseEvent: SecurityLedgerEvent = {
  tenant_id: 'tenant-vfarm-01',
  actor: 'test_actor',
  role: 'test_role',
  entry_point: 'webhook',
  tool_or_route: 'test.route',
  outcome: 'ok',
  reason: 'test reason',
  correlation_id: 'corr_test_001',
};

describe('Logger.audit — security ledger persistence', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits to the in-memory ring buffer and console', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    Logger.audit(baseEvent);

    const recent = Logger.getRecentAuditEvents(5);
    expect(recent).toHaveLength(1);
    expect(recent[0].actor).toBe('test_actor');
    expect(recent[0].outcome).toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('marks refused outcomes with tripwire in console output', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    Logger.audit({ ...baseEvent, outcome: 'refused', reason: 'denied' });

    const recent = Logger.getRecentAuditEvents(5);
    expect(recent[0].outcome).toBe('refused');

    // The console.warn output is a JSON string. Find the audit log line
    // (the DbClient in-memory info also calls console.log, not console.warn,
    // so the warn call is the audit log).
    const auditWarn = warnSpy.mock.calls.find((call) => {
      const arg = call[0];
      if (typeof arg !== 'string') return false;
      try {
        const parsed = JSON.parse(arg);
        return parsed.type === 'SECURITY_LEDGER' && parsed.tripwire === true;
      } catch {
        return false;
      }
    });

    expect(auditWarn).toBeDefined();
    const parsed = JSON.parse(auditWarn![0]);
    expect(parsed.tripwire).toBe(true);
    expect(parsed.level).toBe('WARN');
  });

  it('marks error outcomes with ERROR level in console output', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    Logger.audit({ ...baseEvent, outcome: 'error' });

    const auditError = errorSpy.mock.calls.find((call) => {
      const arg = call[0];
      if (typeof arg !== 'string') return false;
      try {
        const parsed = JSON.parse(arg);
        return parsed.type === 'SECURITY_LEDGER' && parsed.level === 'ERROR';
      } catch {
        return false;
      }
    });

    expect(auditError).toBeDefined();
    const parsed = JSON.parse(auditError![0]);
    expect(parsed.level).toBe('ERROR');
  });

  it('caps the in-memory ring buffer at 200 entries', () => {
    for (let i = 0; i < 250; i++) {
      Logger.audit({ ...baseEvent, correlation_id: `corr_${i}` });
    }

    const recent = Logger.getRecentAuditEvents(250);
    expect(recent.length).toBeLessThanOrEqual(200);
    // The most recent should be corr_249.
    expect(recent[0].correlation_id).toBe('corr_249');
  });

  it('attempts to persist to the database when a pool is present', async () => {
    // Mock the pool so getPool() returns something.
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 'ledger_test' }] }),
    };
    DbClient.setPool(mockPool as any);

    const recordSpy = vi.spyOn(DbClient, 'recordSecurityLedgerEvent');

    Logger.audit({ ...baseEvent, outcome: 'ok', reason: 'persist test', correlation_id: 'corr_persist_001' });

    // Allow the fire-and-forget dynamic import to resolve.
    await new Promise((r) => setTimeout(r, 50));

    expect(recordSpy).toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'ok',
        reason: 'persist test',
        correlation_id: 'corr_persist_001',
      }),
    );

    DbClient.setPool(null);
  });
});

describe('DbClient.recordSecurityLedgerEvent', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('persists an event with all supported fields when pool is present', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    const event: SecurityLedgerEvent = {
      id: 'ledger_manual_id',
      timestamp: '2026-10-30T00:00:00.000Z',
      tenant_id: 'tenant-vfarm-01',
      actor: 'test_actor',
      role: 'system',
      entry_point: 'api',
      tool_or_route: 'processOutboundQueue',
      outcome: 'ok',
      reason: 'Twilio send succeeded',
      correlation_id: 'corr_abc',
    };

    await DbClient.recordSecurityLedgerEvent(event);

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [query, params] = mockPool.query.mock.calls[0];

    // Verify all columns are in the INSERT statement
    expect(query).toContain('security_ledger');
    expect(query).toContain('tripwire');
    expect(query).toContain('level');

    // Verify all params are present
    expect(params).toHaveLength(12);
    expect(params[0]).toBe('ledger_manual_id'); // id
    expect(params[1]).toBe('2026-10-30T00:00:00.000Z'); // timestamp
    expect(params[2]).toBe('tenant-vfarm-01'); // tenant_id
    expect(params[3]).toBe('test_actor'); // actor
    expect(params[4]).toBe('system'); // role
    expect(params[5]).toBe('api'); // entry_point
    expect(params[6]).toBe('processOutboundQueue'); // tool_or_route
    expect(params[7]).toBe('ok'); // outcome
    expect(params[8]).toBe('Twilio send succeeded'); // reason
    expect(params[9]).toBe('corr_abc'); // correlation_id
    expect(params[10]).toBe(false); // tripwire (ok outcome -> false)
    expect(params[11]).toBe('INFO'); // level

    DbClient.setPool(null);
  });

  it('sets tripwire=true and level=WARN for refused outcomes', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    await DbClient.recordSecurityLedgerEvent({
      ...baseEvent,
      outcome: 'refused',
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[10]).toBe(true); // tripwire
    expect(params[11]).toBe('WARN'); // level

    DbClient.setPool(null);
  });

  it('sets tripwire=false and level=ERROR for error outcomes', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    await DbClient.recordSecurityLedgerEvent({
      ...baseEvent,
      outcome: 'error',
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[10]).toBe(false); // tripwire
    expect(params[11]).toBe('ERROR'); // level

    DbClient.setPool(null);
  });

  it('generates a UUID id when none is provided', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    await DbClient.recordSecurityLedgerEvent({
      ...baseEvent,
      // No id field
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[0]).toMatch(/^ledger_/);

    DbClient.setPool(null);
  });

  it('generates a default reason when reason is not provided', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    await DbClient.recordSecurityLedgerEvent({
      ...baseEvent,
      reason: undefined,
      outcome: 'ok',
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[8]).toBe('security ledger ok');

    DbClient.setPool(null);
  });

  it('does not throw and logs error when the database insert fails', async () => {
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    DbClient.setPool(mockPool as any);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      DbClient.recordSecurityLedgerEvent({ ...baseEvent, outcome: 'ok' }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DbClient.recordSecurityLedgerEvent Postgres Error'),
    );

    DbClient.setPool(null);
  });

  it('logs an info message when no pool is configured (in-memory mode)', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // No pool set
    await DbClient.recordSecurityLedgerEvent({ ...baseEvent, outcome: 'ok' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Security ledger event (in-memory only)'),
    );

    infoSpy.mockRestore();
  });

  it('handles null tenant_id correctly', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    await DbClient.recordSecurityLedgerEvent({
      ...baseEvent,
      tenant_id: null,
      actor: 'twilio_delivery_status',
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[2]).toBeNull(); // tenant_id can be null

    DbClient.setPool(null);
  });
});
