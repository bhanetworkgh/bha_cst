/**
 * Log-output privacy for the outbound SMS paths.
 *
 * CST logs and audit entries are retained and read by operators, auditors and
 * reviewers, so they must not carry raw customer identifiers. The policy is in
 * `engine/src/util/privacy.ts`:
 *
 *   - a RECIPIENT / CALLER number is a customer identifier and is masked;
 *   - a SERVICE number (a number CST owns) is not, and may appear unmasked;
 *   - a provider MessageSid is a per-customer handle and is masked in log
 *     output, while the raw value stays in the database where the delivery
 *     event contract needs it.
 *
 * These tests drive the real handlers with real log capture and assert that
 * the raw identifiers never reach the log stream. They use a deterministic
 * mock, never a live provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';
import { maskPhone, maskProviderSid } from '../../engine/src/util/privacy.js';
import { Logger } from '../../engine/src/config/logger.js';

const app = createApp();
const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const SERVICE_DID = '+19715885823';
const RECIPIENT = '+15551234567';
const MESSAGE_SID = 'SM9f2c1a4b7d3e8f0a1b2c3d4';

describe('privacy helpers', () => {
  it('masks a recipient number, keeping only the last four digits', () => {
    const masked = maskPhone(RECIPIENT);
    expect(masked).not.toBe(RECIPIENT);
    expect(masked).not.toContain('1555123');
    expect(masked.endsWith('4567')).toBe(true);
  });

  it('masks a provider message id but keeps a correlatable prefix', () => {
    const masked = maskProviderSid(MESSAGE_SID);
    expect(masked).not.toBe(MESSAGE_SID);
    expect(masked.startsWith('SM9f2c')).toBe(true);
    expect(masked).not.toContain(MESSAGE_SID.slice(6));
  });

  it('leaves a value that is too short to mask safely alone', () => {
    expect(maskPhone('+1')).toBe('+1');
    expect(maskProviderSid('SM1')).toBe('SM1');
  });
});

describe('outbound paths — no customer identifier reaches the log stream', () => {
  let logLines: string[] = [];

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
    logLines = [];

    // Capture everything the Logger writes.
    for (const level of ['info', 'warn', 'error', 'audit', 'infra'] as const) {
      vi.spyOn(Logger as any, level).mockImplementation((...args: any[]) => {
        try {
          logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        } catch {
          logLines.push(String(args[0]));
        }
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('the delivery-status refusal does not log the raw MessageSid or the recipient', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_priv_001',
      tenant_id: TENANT,
      project_id: PROJECT,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'privacy fixture',
      correlation_id: 'turn_priv_001',
      turn_id: 'turn_priv_001',
      provider_sid: MESSAGE_SID,
      status: 'sent',
    } as any);

    // A row with no tenancy: the callback must refuse and log a masked
    // identifier, never the raw provider handle.
    await DbClient.saveOutboundMessage({
      id: 'out_priv_002',
      tenant_id: '',
      project_id: '',
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'privacy fixture 2',
      correlation_id: 'turn_priv_002',
      turn_id: 'turn_priv_002',
      provider_sid: 'SM2b3c4d5e6f7a8b9c0d1e2f3',
      status: 'sent',
    } as any);

    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM2b3c4d5e6f7a8b9c0d1e2f3',
        MessageStatus: 'delivered',
        To: RECIPIENT,
        From: SERVICE_DID,
      });
    expect(res.status).toBe(204);

    const stream = logLines.join('\n');
    expect(stream.length).toBeGreaterThan(0);
    expect(stream).not.toContain('SM2b3c4d5e6f7a8b9c0d1e2f3');
    expect(stream).not.toContain(RECIPIENT);
    // The masked form IS present, so the operator can still correlate.
    expect(stream).toContain('SM2b3c');
  });

  it('the worker failure diagnostics do not log the raw recipient number', async () => {
    // A non-retriable provider error, which produces the loudest diagnostics
    // in the worker.
    TwilioClientWrapper.setMockHandler(async () => {
      throw Object.assign(new Error('21211: Invalid To Phone Number'), { code: 21211, status: 400 });
    });

    await DbClient.saveOutboundMessage({
      id: 'out_priv_003',
      tenant_id: TENANT,
      project_id: PROJECT,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'privacy fixture 3',
      correlation_id: 'turn_priv_003',
      turn_id: 'turn_priv_003',
      status: 'pending',
    } as any);

    const { processOutboundQueue } = await import('../../engine/src/transport/twilio/outbound.js');
    await processOutboundQueue();

    const stream = logLines.join('\n');
    expect(stream).not.toContain(RECIPIENT);
    // The service number CST owns is NOT a customer identifier, so it may
    // stay legible for triage. It is not asserted to be present — only that
    // no CUSTOMER identifier is.
    expect(stream).not.toContain('SECRET');
  });
});
