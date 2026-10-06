/**
 * DbClient persistence against a real PostgreSQL database.
 *
 * This replaces `tests/db_test.ts`, which vitest never collected: the filename
 * ended `_test.ts` while `vitest.config.ts` includes only `tests` files matching
 * the `.test.ts` suffix. It was dead code that also mutated `process.env` and
 * opened a database at import time, so it was a landmine rather than coverage.
 * It is rewritten here as a real, collected suite using the same
 * `CST_DB_TESTS=1` opt-in as `tests/transport/delivery_persistence.test.ts` —
 * and notably it is the only place that exercised `saveInboundMessage` against
 * real SQL, which is why the correct `'system-vfarm-01'` value was never noticed
 * as different from the project ids other call sites pass.
 *
 * Skipped automatically unless opted in, so the suite stays runnable with no
 * database and no secrets.
 *
 * Run with: CST_DB_TESTS=1 npx vitest run tests/db/db_client_persistence.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';

const ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

if (!ENABLED) {
  describe('DbClient persistence (requires CST_DB_TESTS=1 and DATABASE_URL, skipped)', () => {
    it('is skipped because no database is configured for these tests', () => {
      expect(ENABLED).toBe(false);
    });
  });
} else {
  describe('DbClient persistence — real PostgreSQL', () => {
    const suffix = `${Date.now()}`;
    const messageId = `SM_PERSIST_${suffix}`;
    // The idempotency test needs its own MessageSid. Tests in a suite share
    // database state, and the round-trip test above already stores `messageId`,
    // so reusing it would make the *first* insert in that test a legitimate
    // duplicate.
    const dupeId = `SM_PERSIST_DUPE_${suffix}`;
    const customerRef = `cust_dbpersist_${suffix}`;
    const conversationIds: string[] = [];
    let pool: pg.Pool;

    beforeAll(async () => {
      // DbClient no longer auto-creates a pool inside a test runner (see
      // engine/src/config/runtime.ts), so the opt-in suite injects one itself.
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      DbClient.setPool(pool);

      // A failure here means the database is unmigrated; report that plainly
      // instead of letting it surface as a logic failure below.
      await pool.query('SELECT message_id FROM messages_in LIMIT 1');

      // The FK parent for messages_in / conversations must exist.
      SystemsRegistry.resetToDefault();
      await SystemsRegistry.whenPersisted();
      const sys = await pool.query('SELECT system_id FROM systems WHERE tenant_id = $1', [
        'tenant-vfarm-01',
      ]);
      expect(sys.rows.length, 'systems FK parent row for tenant-vfarm-01').toBeGreaterThan(0);
    });

    afterAll(async () => {
      if (pool) {
        await pool.query('DELETE FROM messages_in WHERE message_id = ANY($1)', [
          [messageId, dupeId],
        ]);
        if (conversationIds.length) {
          await pool.query('DELETE FROM messages WHERE conversation_id = ANY($1)', [
            conversationIds,
          ]);
          await pool.query('DELETE FROM conversations WHERE conversation_id = ANY($1)', [
            conversationIds,
          ]);
        }
        await pool.query('DELETE FROM customers WHERE customer_ref = $1', [customerRef]);
      }
      await DbClient.disconnect();
    });

    it('persists an inbound message and reads it back from SQL', async () => {
      await DbClient.saveInboundMessage({
        message_id: messageId,
        tenant_id: 'tenant-vfarm-01',
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        body: 'real PostgreSQL persistence check',
        media: [],
        received_at: new Date().toISOString(),
        correlation_id: `corr_${suffix}`,
      });

      const res = await pool.query(
        'SELECT message_id, tenant_id, from_e164, to_e164, body FROM messages_in WHERE message_id = $1',
        [messageId],
      );
      expect(res.rows, 'messages_in row must exist').toHaveLength(1);
      expect(res.rows[0].tenant_id).toBe('tenant-vfarm-01');
      expect(res.rows[0].from_e164).toBe('+15551112222');
      expect(res.rows[0].body).toBe('real PostgreSQL persistence check');
    });

    it('persists a conversation with a system_id that has a row in systems', async () => {
      // The original dead test passed 'system-vfarm-01' here. That is the value
      // the FK requires; CoreEngine used to pass a project_id instead, which is
      // what produced conversations_system_id_fkey. Passing a project_id must now
      // still work because DbClient resolves the real id from tenant_id.
      const { conversation_id } = await DbClient.getOrCreateConversation(
        'tenant-vfarm-01',
        'proj-vfarm-main',
        customerRef,
        'tenant-vfarm-01',
        undefined,
        'proj-vfarm-main',
      );
      conversationIds.push(conversation_id);

      const res = await pool.query(
        `SELECT c.system_id, s.system_id AS matched
         FROM conversations c JOIN systems s ON s.system_id = c.system_id
         WHERE c.conversation_id = $1`,
        [conversation_id],
      );
      expect(res.rows, 'conversation must join to a systems row').toHaveLength(1);
    });

    it('is idempotent for a duplicate MessageSid (no second row)', async () => {
      const first = await DbClient.saveInboundMessage({
        message_id: dupeId,
        tenant_id: 'tenant-vfarm-01',
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        body: 'duplicate MessageSid check',
        media: [],
        received_at: new Date().toISOString(),
        correlation_id: `corr_dupe_${suffix}`,
      });
      const second = await DbClient.saveInboundMessage({
        message_id: dupeId,
        tenant_id: 'tenant-vfarm-01',
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        body: 'duplicate MessageSid check',
        media: [],
        received_at: new Date().toISOString(),
        correlation_id: `corr_dupe_${suffix}`,
      });
      expect(first.isDuplicate).toBe(false);
      expect(second.isDuplicate).toBe(true);

      const count = await pool.query(
        'SELECT count(*)::int AS n FROM messages_in WHERE message_id = $1',
        [dupeId],
      );
      expect(count.rows[0].n).toBe(1);
    });
  });
}
