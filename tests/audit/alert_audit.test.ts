import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertAuditLog, ALERT_AUDIT_MAX_BYTES } from '../../engine/src/audit/alert_audit.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('AlertAuditLog — 018M Alert Audit & Rendered Body Schema', () => {
  beforeEach(() => {
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('writes immutable alert audit record with write-time secret masking', async () => {
    const writeAuditSpy = vi.spyOn(DbClient, 'writeAlertAuditRow');

    const meta = {
      template_id: 'crop_loss_alert_v1',
      version: '1.0.2',
      params: {
        zone: 'Zone-3',
        threshold_temp: 38.5,
        api_key: 'twilio_secret_token_123',
        Authorization: 'Bearer eyJhbGciOi...',
        nested: {
          token: 'nested_secret',
          safe_val: 'ok',
        },
      },
    };

    await AlertAuditLog.write(
      'out_msg_100',
      'tenant_alpha',
      'Alert: Temperature exceeded 38.5C in Zone-3',
      meta,
      'org_alpha'
    );

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const row = writeAuditSpy.mock.calls[0][0];

    expect(row.outbound_message_id).toBe('out_msg_100');
    expect(row.tenant_id).toBe('tenant_alpha');
    expect(row.organization_id).toBe('org_alpha');
    expect(row.rendered_body).toBe('Alert: Temperature exceeded 38.5C in Zone-3');
    expect(row.truncated).toBe(false);

    // Verify secret masking: stripped at write-time
    expect(row.params).toBeDefined();
    expect(row.params?.api_key).toBeUndefined();
    expect(row.params?.Authorization).toBeUndefined();
    expect((row.params?.nested as any)?.token).toBeUndefined();
    expect((row.params?.nested as any)?.safe_val).toBe('ok');
    expect(row.params?.zone).toBe('Zone-3');

    // masked_at should record the timestamp because secrets were removed
    expect(row.masked_at).not.toBeNull();
    expect(typeof row.masked_at).toBe('string');

    // expires_at should be ~90 days in the future
    const nowMs = Date.now();
    const expiresMs = new Date(row.expires_at).getTime();
    const daysDiff = (expiresMs - nowMs) / (1000 * 60 * 60 * 24);
    expect(daysDiff).toBeGreaterThan(89);
    expect(daysDiff).toBeLessThan(91);
  });

  it('sets masked_at to null when no secrets are present in params', async () => {
    const writeAuditSpy = vi.spyOn(DbClient, 'writeAlertAuditRow');

    await AlertAuditLog.write(
      'out_msg_101',
      'tenant_alpha',
      'Normal status notification',
      {
        template_id: 'info_v1',
        params: { user: 'Alice', count: 5 },
      }
    );

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const row = writeAuditSpy.mock.calls[0][0];
    expect(row.masked_at).toBeNull();
  });

  it('enforces size cap and sets truncated flag when body exceeds 64 KiB', async () => {
    const writeAuditSpy = vi.spyOn(DbClient, 'writeAlertAuditRow');

    // Create a payload larger than ALERT_AUDIT_MAX_BYTES (65536)
    const largeBody = 'A'.repeat(ALERT_AUDIT_MAX_BYTES + 5000);

    await AlertAuditLog.write(
      'out_msg_oversized',
      'tenant_alpha',
      largeBody
    );

    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const row = writeAuditSpy.mock.calls[0][0];

    expect(row.truncated).toBe(true);
    expect(Buffer.byteLength(row.rendered_body, 'utf8')).toBeLessThanOrEqual(ALERT_AUDIT_MAX_BYTES);
    expect(row.rendered_body.length).toBe(ALERT_AUDIT_MAX_BYTES);
  });

  it('never throws or interrupts execution if DbClient.writeAlertAuditRow fails', async () => {
    vi.spyOn(DbClient, 'writeAlertAuditRow').mockRejectedValueOnce(new Error('Database unavailable'));

    // Should resolve cleanly without throwing
    await expect(
      AlertAuditLog.write('out_msg_err', 'tenant_alpha', 'Testing fail-safe')
    ).resolves.toBeUndefined();
  });
});
