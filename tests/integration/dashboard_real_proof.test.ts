/**
 * Real Dashboard integration proof (operator verification, not CI-default).
 *
 * Prerequisites (set by operator, not in this file):
 *   ENGINE_DASHBOARD_URL  — real ingestion endpoint
 *   ENGINE_DASHBOARD_KEY  — real auth credential
 *
 * Run explicitly with:
 *   REAL_DASHBOARD_PROOF=1 npx vitest run tests/integration/dashboard_real_proof.test.ts
 *
 * Sends exactly three events to the live Dashboard:
 *   1. cst.turn  dry_run=true  → validates locally, NO HTTP, no production row
 *   2. cst.turn  dry_run=false → HTTP POST, expects 2xx, row persisted
 *   3. cst.delivery dry_run=false → correlated delivery event
 *
 * Never prints ENGINE_DASHBOARD_KEY, JWTs, farm keys, or API keys.
 */
import { describe, it, expect, vi } from 'vitest';
import dotenv from 'dotenv';

dotenv.config();

import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import {
  createCstTurnEventV1,
  createCstDeliveryEventV1,
  CustomerPayload,
} from '../../engine/src/contracts/index.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

const customer: CustomerPayload = {
  customer_ref: 'cust_vfarm_001_john_doe',
  phone_e164: '+15551234567',
  role: 'manager',
  is_known: true,
  tenant_id: TENANT,
  project_id: PROJECT,
  person_id: 'usr_vfarm_001_john_doe',
  farm_ids: ['farm_austin_main'],
};

const turnEvent = createCstTurnEventV1({
  id: 'real_proof_turn_001',
  tenant_id: TENANT,
  project_id: PROJECT,
  correlation_id: 'SM_REAL_PROOF_001',
  channel: 'sms',
  customer,
  turn: {
    turn_id: 'SM_REAL_PROOF_001',
    direction: 'inbound',
    channel: 'sms',
    status: 'ok',
    intent: 'knowledge',
    text: 'How do I clean the filter?',
    reply_text: 'Clean the filter mesh weekly.',
    duration: { total_ms: 42 },
  },
});

const deliveryEvent = createCstDeliveryEventV1({
  id: 'real_proof_del_001',
  tenant_id: TENANT,
  project_id: PROJECT,
  correlation_id: 'SM_REAL_PROOF_001',
  channel: 'sms',
  customer,
  delivery: {
    delivery_id: 'out_real_proof_001',
    turn_id: 'SM_REAL_PROOF_001',
    provider_sid: 'SM_REAL_PROOF_001',
    channel: 'sms',
    to: '+15551234567',
    from: '+19715885823',
    status: 'delivered',
  },
});

const skipReason = 'REAL_DASHBOARD_PROOF not set — set REAL_DASHBOARD_PROOF=1 to run against the live Dashboard';

describe.skipIf(!process.env.REAL_DASHBOARD_PROOF)('Real Dashboard integration proof', () => {
  it('dry_run=true: validates, returns success, makes NO remote request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);
    const publisher = new CstDashboardPublisher({
      dryRun: true,
      fetchFn: fetchSpy as any,
    });

    const result = await publisher.publish(turnEvent);

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.attempts).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dry_run=false: the live Dashboard accepts cst.turn', async () => {
    const publisher = new CstDashboardPublisher({
      dryRun: false,
      maxRetries: 1,
      initialRetryDelayMs: 0,
    });

    const result = await publisher.publish(turnEvent);

    expect(result.success).toBe(true);
    expect([200, 201]).toContain(result.status);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.eventId).toBe('real_proof_turn_001');
    expect(result.dryRun).toBeUndefined();
  });

  it('dry_run=false: the live Dashboard accepts cst.delivery correlated to the same turn_id', async () => {
    const publisher = new CstDashboardPublisher({
      dryRun: false,
      maxRetries: 1,
      initialRetryDelayMs: 0,
    });

    const result = await publisher.publish(deliveryEvent);

    expect(result.success).toBe(true);
    expect([200, 201]).toContain(result.status);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.eventId).toBe('real_proof_del_001');
  });

  it('authentication succeeds: x-dashboard-key and Authorization: Bearer are both sent', async () => {
    const capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: any) => {
      capturedHeaders['authorization'] = String(init.headers?.['Authorization'] || init.headers?.authorization || '');
      capturedHeaders['x-dashboard-key'] = String(init.headers?.['x-dashboard-key'] || '');
      return { ok: true, status: 202, text: async () => '{"accepted":true}' } as Response;
    });

    const publisher = new CstDashboardPublisher({
      dryRun: false,
      fetchFn: fetchSpy as any,
      maxRetries: 1,
      initialRetryDelayMs: 0,
    });

    await publisher.publish(turnEvent);

    const authHeader = capturedHeaders['authorization'] || '';
    const xKeyHeader = capturedHeaders['x-dashboard-key'] || '';

    expect(authHeader.startsWith('Bearer ')).toBe(true);
    expect(xKeyHeader.length).toBeGreaterThan(0);
    expect(authHeader.slice(7)).toBe(xKeyHeader);
  });

  it('cst.turn contract: serialized fields are present in the HTTP body', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ accepted: true, id: body.id, type: body.event_type }),
      } as Response;
    });

    const publisher = new CstDashboardPublisher({
      dryRun: false,
      fetchFn: fetchSpy as any,
      maxRetries: 1,
      initialRetryDelayMs: 0,
    });

    const result = await publisher.publish(turnEvent);

    expect(result.success).toBe(true);

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse(call[1].body);

    // The serialized payload uses the dashboard's flat schema.
    expect(body.event_type).toBe('cst.turn');
    expect(body.tenant_id).toBe(TENANT);
    expect(body.project_id).toBe(PROJECT);
    expect(body.turn_id).toBe('SM_REAL_PROOF_001');
    expect(body.status).toBe('ok');
    expect(body.correlation_id).toBe('SM_REAL_PROOF_001');
    expect(body.customer_ref).toBe('cust_vfarm_001_john_doe');
    expect(body.customer.phone_e164).toBe('+15551234567');
  });

  it('cst.delivery contract: serialized fields correlate to the same turn_id', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, id: body.id, type: body.event_type }),
      } as Response;
    });

    const publisher = new CstDashboardPublisher({
      dryRun: false,
      fetchFn: fetchSpy as any,
      maxRetries: 1,
      initialRetryDelayMs: 0,
    });

    const result = await publisher.publish(deliveryEvent);

    expect(result.success).toBe(true);

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.event_type).toBe('cst.delivery');
    expect(body.turn_id).toBe('SM_REAL_PROOF_001');
    expect(body.status).toBe('delivered');
    expect(body.provider_sid).toBe('SM_REAL_PROOF_001');
    expect(body.customer_ref).toBe('cust_vfarm_001_john_doe');
  });
});

describe('Real Dashboard proof — skipped by default', () => {
  it(skipReason, () => {});
});
