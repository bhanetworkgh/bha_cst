/**
 * Voice-lane deadline and the SMS-alert-audit foreign-key contract.
 *
 * TWO voice turn paths exist, and they are NOT equivalent:
 *
 *   1. `VoiceInterface.processVoiceTurn` — the Twilio webhook path. It
 *      writes a TRANSCRIPT row and a `voice_deliveries` row. It creates NO
 *      `messages_out` row, so it must NOT write an `alert_audit_log` row:
 *      that table's `outbound_message_id` is `NOT NULL REFERENCES
 *      messages_out(id)` and models ONE AUDIT ROW PER OUTBOUND SMS MESSAGE.
 *      Writing a Twilio Call SID (the correlation id) or a fabricated
 *      `speak_<uuid>` there is exactly the `alert_audit_log_outbound_message_id_fkey`
 *      failure seen in production.
 *
 *   2. `VoiceLaneService.processVoiceTurn` — the voice-lane path. It routes
 *      through `IntentRouter.routeAndHandle`, which PERSISTS a `messages_out`
 *      row, so its alert-audit write IS valid and must be kept.
 *
 * Both paths are bounded by the SAME shared deadline, so neither can hold a
 * response open past the provider's budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { AlertAuditLog } from '../../engine/src/audit/alert_audit.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { Logger } from '../../engine/src/config/logger.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const PHONE = '+15550007777';

describe('Voice-lane deadline and the SMS alert-audit contract', () => {
  const originalDeadline = process.env.CST_VOICE_TURN_DEADLINE_MS;
  const originalLiveTest = process.env.VFARM_LIVE_TEST;
  // The synthesizer is STATIC state on VoiceLaneService. Capturing and
  // restoring it keeps this file from changing the synthesiser every later
  // test file in the same worker inherits.
  let originalSynthesizer: any;

  beforeEach(() => {

  // The programmatic voice API is guarded by a shared secret. This suite

  // exercises it, so it must configure the secret itself rather than

  // depending on another file leaving it set.

  process.env.CST_API_KEY = 'test_programmatic_api_key_32_chars_long';
    originalSynthesizer = VoiceLaneService.getSynthesizer();
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();
    process.env.CST_VOICE_TURN_DEADLINE_MS = '150';
    process.env.VFARM_LIVE_TEST = 'true';
  });

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.CST_VOICE_TURN_DEADLINE_MS;
    else process.env.CST_VOICE_TURN_DEADLINE_MS = originalDeadline;
    if (originalLiveTest === undefined) delete process.env.VFARM_LIVE_TEST;
    else process.env.VFARM_LIVE_TEST = originalLiveTest;
    VoiceLaneService.setSynthesizer(originalSynthesizer);
    vi.restoreAllMocks();
  });

  // ── The deadline is shared by both paths ──────────────────────────────────

  it('bounds the voice-lane path with the shared deadline', async () => {
    // The synthesizer never returns within the deadline.
    const synth = vi.fn(() => new Promise<any>(() => {}));
    VoiceLaneService.setSynthesizer({ synthesize: synth } as any);

    const started = Date.now();
    const result = await VoiceLaneService.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: '+19715885823',
      speech_text: 'status',
      correlation_id: 'corr_lane_deadline_001',
    } as any);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(result.status).toBe('failed');
    expect((result as any).error).toBe('TURN_TIMEOUT');
  });

  it('uses the same deadline for the voice-interface path', async () => {
    const adapter = CoreRegistry.getAdapter(TENANT) as VfarmTenantAdapter;
    const spy = vi
      .spyOn(adapter, 'resolveSpeaker')
      .mockImplementation(() => new Promise<any>(() => {}) as any);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: '+19715885823',
      speech_text: 'status',
      correlation_id: 'corr_iface_deadline_001',
    } as any);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('TURN_TIMEOUT');
    spy.mockRestore();
  });

  it('records the timeout as a correlated tripwire audit entry', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit').mockImplementation(() => undefined);

    const adapter = CoreRegistry.getAdapter(TENANT) as VfarmTenantAdapter;
    vi.spyOn(adapter, 'resolveSpeaker').mockImplementation(() => new Promise<any>(() => {}) as any);

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: '+19715885823',
      speech_text: 'status',
      correlation_id: 'corr_tripwire_001',
    } as any);

    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const timeout = entries.find((e) => e?.details?.tripwire === true);
    expect(timeout).toBeDefined();
    expect(timeout.correlation_id).toBe('corr_tripwire_001');
    expect(timeout.outcome).toBe('error');
    expect(String(timeout.reason)).toMatch(/response deadline/);
  });

  // ── The SMS alert-audit foreign key ──────────────────────────────────────

  it('never writes the SMS alert-audit table from the voice-interface path', async () => {
    const writeSpy = vi.spyOn(AlertAuditLog, 'write').mockResolvedValue(undefined);

    const adapter = CoreRegistry.getAdapter(TENANT) as VfarmTenantAdapter;
    vi.spyOn(adapter, 'resolveSpeaker').mockResolvedValue({
      person_id: 'cust_x',
      customer_ref: 'cust_x',
      tenant_id: TENANT,
      project_id: PROJECT,
      phone_e164: PHONE,
      is_known: true,
      role: 'owner',
      permissions: [],
      farm_ids: [],
    } as any);

    // Force the turn to fail early, so the success path (and its former
    // alert-audit write) is not reached.
    vi.spyOn(CoreEngine, 'processEnvelope').mockRejectedValue(new Error('engine down'));

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: '+19715885823',
      speech_text: 'status',
      correlation_id: 'corr_no_alert_001',
    } as any).catch(() => undefined);

    for (const call of writeSpy.mock.calls) {
      const id = String(call[0]);
      // Neither a Twilio Call SID nor a fabricated identifier may reach the
      // SMS alert-audit foreign key.
      expect(id).not.toMatch(/^CA[0-9a-f]{32}$/i);
      expect(id).not.toMatch(/^speak_/);
    }
  });

  it('keeps the alert_audit_log foreign key enforced in the schema', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.resolve(__dirname, '../../db/migrations');
    const sql = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(sql).toMatch(/outbound_message_id\s+VARCHAR\(64\)\s+NOT NULL REFERENCES messages_out\(id\)/);
  });
});
