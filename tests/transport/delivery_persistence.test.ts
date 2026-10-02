/**
 * Delivery-status persistence against a real PostgreSQL database.
 *
 * The in-memory unit tests cannot catch a defect in the SQL WHERE clause: the
 * in-memory store answers the lookup even when the SQL matches nothing. That
 * is exactly how a real bug shipped — `updateDeliveryStatusByProviderSid`
 * matched only `id`/`correlation_id` and never `provider_sid`, so once the
 * process restarted (empty in-memory store) a Twilio callback updated nothing,
 * resolved no tenant/project, and refused to publish the delivery. These tests
 * run the same call against the configured database and assert the row changed.
 *
 * Skipped automatically when DATABASE_URL is unset or unreachable, so the suite
 * stays runnable without a database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { DbClient } from '../../engine/src/db/client.js';

// Opt-in: the shared suite must never depend on a developer's local database.
// Run with: CST_DB_TESTS=1 npx vitest run tests/transport/delivery_persistence.test.ts
const ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

if (!ENABLED) {
  describe('cst.delivery persistence (requires DATABASE_URL, skipped)', () => {
    it('is skipped because no database is configured for these tests', () => {
      expect(ENABLED).toBe(false);
    });
  });
} else {
  describe('cst.delivery persistence — real PostgreSQL', () => {
    const suffix = `${Date.now()}`;
    const rows: string[] = [];
    let pool: any;

    const save = async (over: Record<string, any> = {}) => {
      const id = `out_persist_${suffix}_${rows.length}`;
      rows.push(id);
      await DbClient.saveOutboundMessage({
        id,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        to_e164: '+15551112222',
        from_e164: '+19715885823',
        body: 'persistence check',
        correlation_id: `turn_${id}`,
        turn_id: `turn_${id}`,
        status: 'sent',
        ...over,
      } as any);
      return id;
    };

    beforeAll(async () => {
      // DbClient.getPool() is disabled under NODE_ENV=test, so the pool is
      // constructed explicitly and injected.
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      DbClient.setPool(pool);
      // A failure here means the test database has not been migrated, and the
      // assertions below would fail for schema reasons rather than logic ones.
      await pool.query('SELECT turn_id FROM messages_out LIMIT 1');
    });

    afterAll(async () => {
      if (pool && rows.length) {
        await pool.query('DELETE FROM messages_out WHERE id = ANY($1)', [rows]);
      }
      await DbClient.disconnect();
    });

    it('persists the delivery status and returns the correlation context from the row', async () => {
      const id = await save();
      const sid = `SM_PERSIST_${id}`;
      await DbClient.updateOutboundProviderSid(id, sid);

      const res = await DbClient.updateDeliveryStatusByProviderSid(sid, 'delivered');

      expect(res.advanced).toBe(true);
      // Context is resolved from the persisted row (the in-memory store is
      // never consulted here, so a missing provider_sid match shows up as nulls).
      expect(res.tenant_id).toBe('tenant-vfarm-01');
      expect(res.project_id).toBe('proj-vfarm-main');
      expect(res.message_id).toBe(id);
      expect(res.turn_id).toBe(`turn_${id}`);
      expect(res.to_e164).toBe('+15551112222');
      expect(res.from_e164).toBe('+19715885823');

      const row = await pool.query('SELECT status FROM messages_out WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('delivered');
    });

    it('does not regress stored state on a late lower-ranked callback', async () => {
      const id = await save();
      const sid = `SM_REGRESS_${id}`;
      await DbClient.updateOutboundProviderSid(id, sid);
      await DbClient.updateDeliveryStatusByProviderSid(sid, 'delivered');

      const res = await DbClient.updateDeliveryStatusByProviderSid(sid, 'sent');

      expect(res.advanced).toBe(false);
      const row = await pool.query('SELECT status FROM messages_out WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('delivered');
    });

    it('records the error details for a failure callback', async () => {
      const id = await save();
      const sid = `SM_FAIL_${id}`;
      await DbClient.updateOutboundProviderSid(id, sid);

      await DbClient.updateDeliveryStatusByProviderSid(sid, 'failed', 'Twilio ErrorCode: 30008');

      const row = await pool.query(
        'SELECT status, error_message FROM messages_out WHERE id = $1',
        [id]
      );
      expect(row.rows[0].status).toBe('failed');
      expect(row.rows[0].error_message).toContain('30008');
    });

    it('still resolves the turn_id when the monotonic guard suppresses the transition', async () => {
      // A late `delivered` for a message already recorded as `failed` is a
      // regression, so no row is updated. The published cst.delivery must still
      // carry the join key, otherwise the Dashboard cannot link it to a
      // cst.turn and the event is effectively orphaned.
      const id = await save();
      const sid = `SM_SUPPRESSED_${id}`;
      await DbClient.updateOutboundProviderSid(id, sid);
      await DbClient.updateDeliveryStatusByProviderSid(sid, 'failed', 'Twilio ErrorCode: 30008');

      const res = await DbClient.updateDeliveryStatusByProviderSid(sid, 'delivered');

      expect(res.advanced).toBe(false); // regression suppressed
      expect(res.turn_id).toBe(`turn_${id}`);
      expect(res.tenant_id).toBe('tenant-vfarm-01');
      expect(res.project_id).toBe('proj-vfarm-main');
      // And the stored state is genuinely untouched.
      const row = await pool.query('SELECT status FROM messages_out WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('failed');
    });

    it('reports no update for a provider sid that was never sent', async () => {
      const res = await DbClient.updateDeliveryStatusByProviderSid(
        `SM_NEVER_${suffix}`,
        'delivered'
      );
      expect(res.advanced).toBe(false);
      expect(res.tenant_id).toBeUndefined();
      expect(res.project_id).toBeUndefined();
    });
  });
}
