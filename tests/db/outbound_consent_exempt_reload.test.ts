import { describe, it, expect, afterEach } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';

// 8 Nov 2026: pending rows reloaded from Postgres dropped consent_exempt, so in
// production every HELP, STOP-confirmation, onboarding and calls-only reply to
// a not-yet-consented sender was blocked by the consent gate.
describe('pending outbound reload keeps consent_exempt', () => {
  afterEach(() => {
    DbClient.setPool(null);
    DbClient.clearAll();
  });

  it('carries the flag from the queued record onto the reloaded row', async () => {
    DbClient.clearAll();
    const rows: any[] = [];
    const fakePool: any = {
      query: async (sql: string, params: any[]) => {
        if (/INSERT INTO messages_out/.test(sql)) {
          rows.push({
            id: params[0], tenant_id: params[1], project_id: params[2], from_e164: params[3], to_e164: params[4],
            body: params[5], media_url: params[6], correlation_id: params[7], turn_id: params[8], provider_sid: null,
            status: params[9], retry_count: params[10], error_message: params[11], created_at: params[12], next_retry_at: null,
          });
          return { rows: [], rowCount: 1 };
        }
        if (/FROM messages_out/.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      },
    };
    DbClient.setPool(fakePool);

    await DbClient.saveOutboundMessage({
      tenant_id: 't1', project_id: 'p1', from_e164: '+19715885823', to_e164: '+15550001111',
      body: 'HELP reply', correlation_id: 'c1', status: 'pending', consent_exempt: true,
    } as any);
    await DbClient.saveOutboundMessage({
      tenant_id: 't1', project_id: 'p1', from_e164: '+19715885823', to_e164: '+15550002222',
      body: 'normal reply', correlation_id: 'c2', status: 'pending',
    } as any);

    const pending = await DbClient.getPendingOutboundMessages();
    const help = pending.find((m) => m.body === 'HELP reply');
    const normal = pending.find((m) => m.body === 'normal reply');
    expect(help?.consent_exempt).toBe(true);
    expect(normal?.consent_exempt).toBeFalsy();
  });
});
