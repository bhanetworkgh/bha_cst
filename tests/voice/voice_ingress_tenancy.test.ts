/**
 * Voice ingress tenancy (item 3, G9/G14).
 *
 * The receiving number's `service_number_binding` is the tenancy
 * AUTHORITY for voice ingress:
 *
 *   Twilio To -> service_number_binding -> tenant_id + project_id
 *
 * `SystemsRegistry` supplies NON-IDENTITY runtime configuration only
 * (system name, onboarding copy, BHARAG workspace key, ElevenLabs
 * voice pointer). It cannot admit a call, and it cannot set the
 * tenant. These tests pin that a number can never enter the pipeline
 * on the strength of the systems registry alone, and that a
 * registry/binding disagreement is refused rather than resolved by
 * picking a winner.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';

/** Refusal reason, or undefined for a non-refused result. */
function refusalReason(result: { status: string; reason?: string }): string | undefined {
  return result.status === 'refused' ? result.reason : undefined;
}

describe('Voice ingress tenancy is binding-authoritative', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
  });

  it('refuses a receiving number that is only known to SystemsRegistry (no binding)', async () => {
    // '+19998887777' is registered as a system phone number, so under
    // the old order (system lookup first) this call was ADMITTED and
    // identity was then resolved from the unscoped customers table.
    SystemsRegistry.registerSystem({
      ...SystemsRegistry.getSystemByTenantId('tenant-vfarm-01')!,
      system_id: 'system-unbound-01',
      phone_numbers: ['+19998887777'],
    });
    expect(SystemsRegistry.resolveSystemByPhoneNumber('+19998887777')).not.toBeNull();
    expect(CoreRegistry.resolveServiceNumber('+19998887777')).toBeNull();

    const result = await VoiceLaneService.processVoiceTurn({
      from_e164: '+15551112222',
      to_e164: '+19998887777',
      speech_text: 'hello',
      correlation_id: 'corr_voice_unbound_test',
    });

    expect(result.status).toBe('refused');
    expect(refusalReason(result)).toContain('not bound to a project');
  });

  it('refuses a receiving number that is bound but has no runtime system configuration', async () => {
    // Bound to a project, so the tenancy chain resolves — but no system
    // is registered for it, so the deployment is incomplete.
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885829',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
    expect(CoreRegistry.resolveServiceNumber('+19715885829')).not.toBeNull();
    expect(SystemsRegistry.resolveSystemByPhoneNumber('+19715885829')).toBeNull();

    const result = await VoiceLaneService.processVoiceTurn({
      from_e164: '+15551112222',
      to_e164: '+19715885829',
      speech_text: 'hello',
      correlation_id: 'corr_voice_noconfig_test',
    });

    expect(result.status).toBe('refused');
    expect(refusalReason(result)).toContain('no runtime system configuration');
  });

  it('refuses when the binding tenant and the system configuration tenant disagree', async () => {
    // The binding says tenant-other-99; the registry says tenant-vfarm-01.
    // Neither may silently override the other, because the binding is the
    // authority that admitted the call while the registry is only config.
    CoreRegistry.registerProject({
      project_id: 'proj-other',
      tenant_id: 'tenant-other-99',
      name: 'Other Tenant Project',
      status: 'active',
      tenant_org_id: '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
      synced_at: new Date().toISOString(),
    });
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-other-99', name: 'Other Tenant', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      CoreRegistry.getAdapter('tenant-vfarm-01') ?? undefined
    );
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885830',
      tenant_id: 'tenant-other-99',
      project_id: 'proj-other',
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
    SystemsRegistry.registerSystem({
      ...SystemsRegistry.getSystemByTenantId('tenant-vfarm-01')!,
      system_id: 'system-conflict-01',
      organization_id: 'tenant-vfarm-01',
      tenant_id: 'tenant-vfarm-01',
      phone_numbers: ['+19715885830'],
    });

    const result = await VoiceLaneService.processVoiceTurn({
      from_e164: '+15551112222',
      to_e164: '+19715885830',
      speech_text: 'hello',
      correlation_id: 'corr_voice_conflict_test',
    });

    expect(result.status).toBe('refused');
    expect(refusalReason(result)).toContain('conflict');
  });

  it('still admits a receiving number whose binding and configuration agree', async () => {
    const result = await VoiceLaneService.processVoiceTurn({
      from_e164: '+19990000000', // not onboarded anywhere
      to_e164: '+19715885823',   // bound + configured
      speech_text: 'hello',
      correlation_id: 'corr_voice_admit_test',
    });

    // The caller is unknown, so this must not be a TENANCY refusal —
    // the caller is routed to onboarding instead.
    expect(result.status).not.toBe('refused');
    expect(refusalReason(result)).toBeUndefined();
  });
});
