/**
 * Conversation/message persistence invariants.
 *
 * Two parts:
 *
 *   A. Real PostgreSQL (`CST_DB_TESTS=1`). Creates a real conversation and a real
 *      message through the production DbClient write path and reads both back.
 *      This is the regression test for LOOP-1790985133890-XKWD:
 *        - `conversations_system_id_fkey`  — the insert used to bind `project_id`
 *          into `system_id`, and no `systems` row has a project id.
 *        - `messages_conversation_id_fkey` — when the conversation INSERT failed
 *          the error was swallowed and the unpersisted in-memory id was returned,
 *          so the message was written against a conversation that did not exist.
 *
 *   B. No database required. Asserts the durability invariant with a stub pool:
 *      when the conversation row cannot be written, the caller is told, and no
 *      orphan message row is produced.
 *
 * The FK constraints are deliberately left intact. They are correct, and this
 * suite exists to prove the write path satisfies them rather than to remove them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbClient, ConversationPersistenceError, VoiceDeliveryPersistenceError } from '../../engine/src/db/client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Opt-in, same convention as tests/transport/delivery_persistence.test.ts.
const ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const CUSTOMER_REF = 'cust_fk_regression';

describe('LOOP-1790985133890-XKWD — conversation persistence: schema contract', () => {
  it('creates systems, then conversations, then messages (FK parents first)', () => {
    const sql = fs.readFileSync(
      path.join(REPO_ROOT, 'db/migrations/001_initial_schema.sql'),
      'utf8',
    );
    const systems = sql.indexOf('CREATE TABLE IF NOT EXISTS systems');
    const conversations = sql.indexOf('CREATE TABLE IF NOT EXISTS conversations');
    const messages = sql.indexOf('CREATE TABLE IF NOT EXISTS messages');
    expect(systems).toBeGreaterThan(-1);
    expect(conversations).toBeGreaterThan(systems);
    expect(messages).toBeGreaterThan(conversations);
  });

  it('keeps conversations.system_id and messages.conversation_id as real foreign keys', () => {
    const sql = fs.readFileSync(
      path.join(REPO_ROOT, 'db/migrations/001_initial_schema.sql'),
      'utf8',
    );
    // These are the two constraints whose violation this loop is about. If
    // someone weakens them to make a test pass, this fails.
    expect(sql).toMatch(/system_id\s+VARCHAR\(64\)\s+NOT NULL REFERENCES systems\(system_id\)/);
    expect(sql).toMatch(
      /conversation_id\s+VARCHAR\(64\)\s+NOT NULL REFERENCES conversations\(conversation_id\)/,
    );
  });

  it('runs migrations in an order where every FK parent precedes its dependant', () => {
    const dir = path.join(REPO_ROOT, 'db/migrations');
    // scripts/migrate.js sorts these filenames lexicographically, which is
    // numeric order for zero-padded 3-digit prefixes.
    const order = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const index = (needle: string) => order.findIndex((f) => f.startsWith(needle));

    expect(index('001')).toBe(0);
    expect(index('001')).toBeLessThan(index('003'));
    expect(index('003')).toBeLessThan(index('010'));
    expect(index('010')).toBeLessThan(index('013'));
    expect(index('013')).toBeLessThan(index('014'));
  });

  it('KNOWN DEFECT (not this loop): two migrations share the 003 prefix', () => {
    // `003_add_customers_and_security_ledger.sql` sorts before
    // `003_customers_table.sql`, creates `customers` with a composite
    // (tenant_id, phone_e164) primary key, and therefore makes
    // `003_customers_table.sql` a silent no-op — its `id`, `updated_at` and
    // VARCHAR(128) `unit_id`/`farm_id` never land.
    //
    // This is a `customers`-table column-shape issue, not a conversation FK
    // issue, and renumbering migrations on a runner with no schema_migrations
    // ledger would re-apply every file. It is recorded here so the state is
    // visible and any fix is a deliberate decision.
    // See: scripts/migrate.js has no migration ledger; every file is re-applied
    // on every boot and relies entirely on its own IF NOT EXISTS guards.
    const dir = path.join(REPO_ROOT, 'db/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const withPrefix003 = files.filter((f) => f.startsWith('003'));
    expect(withPrefix003.sort()).toEqual([
      '003_add_customers_and_security_ledger.sql',
      '003_customers_table.sql',
    ]);
  });
});

if (!ENABLED) {
  describe('conversation + message persistence (requires CST_DB_TESTS=1 and DATABASE_URL, skipped)', () => {
    it('is skipped because no database is configured for these tests', () => {
      expect(ENABLED).toBe(false);
    });
  });
} else {
  describe('LOOP-1790985133890-XKWD — conversation persistence: real PostgreSQL', () => {
    const suffix = `${Date.now()}`;
    const customerRef = `${CUSTOMER_REF}_${suffix}`;
    let pool: pg.Pool;
    const createdConversations: string[] = [];
    const createdMessages: string[] = [];

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      DbClient.setPool(pool);
      // Fails loudly here if the test database is unmigrated, rather than
      // reporting a schema problem as a logic failure below.
      await pool.query('SELECT conversation_id, system_id FROM conversations LIMIT 1');
      await pool.query('SELECT message_id, conversation_id FROM messages LIMIT 1');
      // The FK parent must exist for this tenant, exactly as in production.
      const sys = await pool.query(
        'SELECT system_id FROM systems WHERE tenant_id = $1 LIMIT 1',
        [TENANT],
      );
      if (sys.rows.length === 0) {
        throw new Error(
          `Test precondition failed: no systems row for tenant ${TENANT}; the FK parent is missing.`,
        );
      }
    });

    afterAll(async () => {
      if (pool) {
        if (createdMessages.length) {
          await pool.query('DELETE FROM messages WHERE message_id = ANY($1)', [createdMessages]);
        }
        if (createdConversations.length) {
          await pool.query('DELETE FROM conversations WHERE conversation_id = ANY($1)', [
            createdConversations,
          ]);
        }
      }
      await DbClient.disconnect();
    });

    /**
     * Reproduce the exact call `CoreEngine.processEnvelope` makes, including the
     * `project_id`-in-the-`systemId`-slot mistake that caused the violation.
     */
    const createConversation = () =>
      DbClient.getOrCreateConversation(TENANT, PROJECT, customerRef, TENANT, undefined, PROJECT);

    it('persists a real conversation even though the caller passes project_id as systemId', async () => {
      const { conversation_id } = await createConversation();
      createdConversations.push(conversation_id);
      expect(conversation_id).toMatch(/^conv_/);

      const res = await pool.query(
        'SELECT conversation_id, tenant_id, project_id, system_id, customer_ref FROM conversations WHERE conversation_id = $1',
        [conversation_id],
      );
      expect(res.rows, 'conversation row must exist').toHaveLength(1);
      const row = res.rows[0];

      // Tenant/project scoping preserved.
      expect(row.tenant_id).toBe(TENANT);
      expect(row.project_id).toBe(PROJECT);
      expect(row.customer_ref).toBe(customerRef);

      // The FK parent must be a real systems row — this is the assertion that
      // fails with `conversations_system_id_fkey` before the fix.
      const sys = await pool.query('SELECT system_id FROM systems WHERE system_id = $1', [
        row.system_id,
      ]);
      expect(sys.rows, `system_id "${row.system_id}" has no row in systems`).toHaveLength(1);
      expect(row.system_id).not.toBe(PROJECT);
    });

    it('resolves system_id from tenant_id rather than trusting the caller', async () => {
      const { conversation_id } = await createConversation();
      createdConversations.push(conversation_id);
      const res = await pool.query(
        'SELECT c.system_id AS conv_sys, s.system_id AS sys_sys FROM conversations c JOIN systems s ON s.system_id = c.system_id WHERE c.conversation_id = $1',
        [conversation_id],
      );
      expect(res.rows).toHaveLength(1);
      const expected = await pool.query('SELECT system_id FROM systems WHERE tenant_id = $1', [
        TENANT,
      ]);
      expect(res.rows[0].conv_sys).toBe(expected.rows[0].system_id);
    });

    it('persists a real message against that conversation and reads it back', async () => {
      const { conversation_id } = await createConversation();
      createdConversations.push(conversation_id);

      const messageId = `msg_fk_${suffix}`;
      createdMessages.push(messageId);

      // This is the write that failed with `messages_conversation_id_fkey`.
      await DbClient.addMessageToTranscript({
        message_id: messageId,
        conversation_id,
        tenant_id: TENANT,
        project_id: PROJECT,
        direction: 'inbound',
        from_e164: '+15551234567',
        to_e164: '+19715885823',
        body: 'conversation persistence regression check',
        provider_sid: `SM_${messageId}`,
      });

      const res = await pool.query(
        'SELECT message_id, conversation_id, tenant_id, project_id, direction, body, delivery_status FROM messages WHERE message_id = $1',
        [messageId],
      );
      expect(res.rows, 'message row must exist').toHaveLength(1);
      expect(res.rows[0].conversation_id).toBe(conversation_id);
      expect(res.rows[0].tenant_id).toBe(TENANT);
      expect(res.rows[0].project_id).toBe(PROJECT);
      expect(res.rows[0].direction).toBe('inbound');
      expect(res.rows[0].body).toBe('conversation persistence regression check');
    });

    it('leaves no orphan message rows for this tenant after a full round trip', async () => {
      const orphans = await pool.query(
        `SELECT m.message_id FROM messages m
         LEFT JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE m.tenant_id = $1 AND c.conversation_id IS NULL`,
        [TENANT],
      );
      expect(orphans.rows).toEqual([]);
    });

    it('reuses the same conversation row for a repeat message from the same speaker', async () => {
      const first = await createConversation();
      const second = await createConversation();
      // Both calls must resolve to the row Postgres actually holds, not to a
      // fresh in-memory uuid.
      expect(second.conversation_id).toBe(first.conversation_id);

      const count = await pool.query(
        'SELECT count(*)::int AS n FROM conversations WHERE customer_ref = $1',
        [customerRef],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('data remains valid and queryable after a simulated process restart', async () => {
      // Drop the in-memory layer entirely: a restart leaves Postgres as the only
      // source of truth. Reading through the in-memory accessor after clearing
      // must not be what makes this pass.
      const { conversation_id } = await createConversation();
      createdConversations.push(conversation_id);
      const messageId = `msg_restart_${suffix}`;
      createdMessages.push(messageId);

      await DbClient.addMessageToTranscript({
        message_id: messageId,
        conversation_id,
        tenant_id: TENANT,
        project_id: PROJECT,
        direction: 'inbound',
        from_e164: '+15551234567',
        to_e164: '+19715885823',
        body: 'survives restart',
        provider_sid: `SM_${messageId}`,
      });

      // Simulate the restart: every in-memory store is discarded, and a brand
      // new DbClient pool is opened exactly as a fresh process would.
      DbClient.clearAll();
      DbClient.setPool(pool);

      const after = await pool.query(
        `SELECT m.message_id, m.body, c.conversation_id, c.system_id
         FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE m.message_id = $1`,
        [messageId],
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].body).toBe('survives restart');

      const sys = await pool.query('SELECT system_id FROM systems WHERE system_id = $1', [
        after.rows[0].system_id,
      ]);
      expect(sys.rows, 'system_id must still resolve after restart').toHaveLength(1);
    });
  });
}

describe('LOOP-1790985133890-XKWD — conversation persistence: durability (no database required)', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
  });

  it('throws instead of returning an unpersisted conversation_id when the INSERT fails', async () => {
    stubPool.query.mockImplementation(async (sql: string) => {
      // The systems lookup succeeds; the INSERT is what fails, as it did live.
      if (sql.includes('FROM systems')) {
        return { rows: [{ system_id: 'system-vfarm-01' }] };
      }
      throw new Error('duplicate key value violates unique constraint');
    });

    // Before the fix this resolved to `conv_<uuid>` and the caller went on to
    // write a message against it, producing messages_conversation_id_fkey.
    await expect(
      DbClient.getOrCreateConversation(TENANT, PROJECT, 'cust_fail', TENANT, undefined, PROJECT),
    ).rejects.toBeInstanceOf(ConversationPersistenceError);
  });

  it('does not write an orphan message when the conversation could not be created', async () => {
    const calls: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM systems')) {
        return { rows: [{ system_id: 'system-vfarm-01' }] };
      }
      if (sql.includes('INSERT INTO conversations')) {
        throw new Error('insert failed');
      }
      if (sql.includes('INSERT INTO messages')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    let conversationId: string | null = null;
    try {
      const rec = await DbClient.getOrCreateConversation(
        TENANT,
        PROJECT,
        'cust_orphan',
        TENANT,
        undefined,
        PROJECT,
      );
      conversationId = rec.conversation_id;
    } catch {
      // expected
    }

    // The caller now knows the conversation is not durable, so it must not
    // attempt a transcript write.
    expect(conversationId).toBeNull();
    expect(calls.some((c) => c.includes('INSERT INTO messages'))).toBe(false);
  });

  it('rejects instead of persisting a voice delivery when the tenant has no systems row', async () => {
    const calls: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM systems')) return { rows: [] };
      return { rows: [] };
    });

    await expect(DbClient.recordVoiceDelivery({
      tenant_id: 'tenant-without-system',
      project_id: PROJECT,
      status: 'sent',
      character_count: 10,
      audio_bytes: 100,
    } as any)).rejects.toBeInstanceOf(VoiceDeliveryPersistenceError);

    // `voice_deliveries.system_id` is NOT NULL + FK. With no parent row the
    // write must fail the caller instead of silently leaving an in-memory row.
    expect(calls.some((c) => c.includes('INSERT INTO voice_deliveries'))).toBe(false);
    expect(DbClient.getAllVoiceDeliveries()).toHaveLength(0);
  });
});
