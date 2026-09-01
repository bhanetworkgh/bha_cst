import { DbClient } from '../engine/src/db/client.js';
import { SystemsRegistry } from '../engine/src/systems/registry.js';

process.env.DATABASE_URL = `postgresql://${process.env.USER || 'postgres'}@localhost:5432/bha_cst`;
process.env.NODE_ENV = 'development';

async function testRealDb() {
  // 1. Seed system record into PostgreSQL systems table
  SystemsRegistry.resetToDefault();

  // 2. Save inbound message into PostgreSQL messages_in table
  const msgId = 'SM_LIVE_DB_TEST_001';
  await DbClient.saveInboundMessage({
    message_id: msgId,
    tenant_id: 'tenant-vfarm-01',
    from_e164: '+15551112222',
    to_e164: '+19715885823',
    body: 'Live PostgreSQL test message',
    media: [],
    received_at: new Date().toISOString(),
    correlation_id: 'corr_live_test',
  });

  const pool = DbClient.getPool();
  if (!pool) {
    console.error('Failed to get pool');
    return;
  }
  const res = await pool.query('SELECT * FROM messages_in WHERE message_id = $1', [msgId]);
  console.log('PostgreSQL Inbound Message Query Result:', res.rows[0]);

  // 3. Save conversation record
  const conv = await DbClient.getOrCreateConversation('tenant-vfarm-01', 'system-vfarm-01', 'cust_vfarm_001_john_doe');
  const convRes = await pool.query('SELECT * FROM conversations WHERE conversation_id = $1', [conv.conversation_id]);
  console.log('PostgreSQL Conversation Query Result:', convRes.rows[0]);

  await pool.end();
}

testRealDb().catch(console.error);
