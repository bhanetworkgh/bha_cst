import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SpeakerIdentity } from '../../engine/src/core/types.js';
import { MessageEnvelope } from '../../engine/src/core/envelope.js';
import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import {
  CstTurnEventV1,
  CstTurnEventV1Schema,
} from '../../engine/src/contracts/index.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { StepUpAuthService } from '../../engine/src/identity/stepup.js';
import { WebInterface } from '../../engine/src/interfaces/web/index.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';

describe('Task 3 — cst.turn: Wire Publisher after CoreEngine.processEnvelope()', () => {
  const publishedEvents: CstTurnEventV1[] = [];

  const testTenant = {
    tenant_id: 'tenant-test-turn',
    name: 'Turn Test Tenant',
    status: 'active' as const,
    adapter_type: 'vfarm',
    created_at: new Date().toISOString(),
  };

  const testProject = {
    project_id: 'proj-test-turn',
    tenant_id: 'tenant-test-turn',
    name: 'Turn Test Project',
    status: 'active' as const,
    capabilities: { sms: true, voice: true, web: true },
    speaker_policy: 'all_project_members' as const,
    onboarding_reply: 'Welcome to Turn Test Project! Please contact admin.',
  };

  const knownSpeaker: SpeakerIdentity = {
    person_id: 'person_turn_1',
    customer_ref: 'cust_turn_owner',
    tenant_id: 'tenant-test-turn',
    project_id: 'proj-test-turn',
    phone_e164: '+15559990001',
    is_known: true,
    role: 'owner',
    permissions: ['farm:read', 'farm:control'],
    farm_ids: ['farm_turn_alpha'],
  };

  beforeEach(() => {
    publishedEvents.length = 0;

    // Register tenant and project in registry
    CoreRegistry.registerTenant(testTenant, null as any);
    CoreRegistry.registerProject(testProject);

    // Mock publisher that captures events
    const mockPublisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.internal/api/v1/events',
      dashboardKey: 'test-key',
    });

    vi.spyOn(mockPublisher, 'publishFireAndForget').mockImplementation((event: any) => {
      publishedEvents.push(event as CstTurnEventV1);
    });

    CoreEngine.setDashboardPublisher(mockPublisher);

    // BHARAG incident creation is stubbed to return a REAL incident id. A
    // response without one is a genuine failure, never a licence to fabricate
    // an id — see the degraded-escalation test below.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/incidents')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ incident_id: 'inc_turn_test_001', status: 'open' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ answer: 'KB answer.' }),
      } as Response;
    });
  });

  afterEach(() => {
    CoreEngine.setDashboardPublisher(null);
    vi.restoreAllMocks();
  });

  describe('Turn Publishing from Channels (SMS, Voice, Web)', () => {
    it('produces exactly one cst.turn for an SMS turn', async () => {
      vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue({
        text: 'Farm alpha: All sensors normal.',
        media_url: undefined,
      } as any);

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'status update',
        media: [],
        correlation_id: 'corr_sms_turn_01',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);
      expect(res.reply_text).toContain('All sensors normal');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.type).toBe('cst.turn');
      expect(turn.channel).toBe('sms');
      expect(turn.data.status).toBe('ok');
      expect(turn.data.turn_id).toBe('corr_sms_turn_01');
      expect(turn.customer.customer_ref).toBe('cust_turn_owner');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('produces exactly one cst.turn for a Voice turn', async () => {
      vi.spyOn(CoreRegistry, 'resolveSpeaker').mockResolvedValue(knownSpeaker);
      vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue({
        text: 'Voice response: Farm alpha normal.',
        media_url: undefined,
      } as any);

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'voice',
        speaker_ref: '+15559990001',
        text: 'status of farm',
        media: [],
        correlation_id: 'corr_voice_turn_02',
      };

      const res = await VoiceInterface.handleVoiceEnvelope(envelope);
      expect(res.reply_text).toContain('Farm alpha normal');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.type).toBe('cst.turn');
      expect(turn.channel).toBe('voice');
      expect(turn.data.status).toBe('ok');
      expect(turn.data.turn_id).toBe('corr_voice_turn_02');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('produces exactly one cst.turn for a Web turn', async () => {
      vi.spyOn(CoreRegistry, 'resolveSpeaker').mockResolvedValue(knownSpeaker);
      vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue({
        text: 'Web response: Greenhouse moisture 65%.',
        media_url: undefined,
      } as any);

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'web',
        speaker_ref: '+15559990001',
        text: 'status check',
        media: [],
        correlation_id: 'corr_web_turn_03',
      };

      const res = await WebInterface.handleWebEnvelope(envelope);
      expect(res.reply_text).toContain('moisture 65%');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.type).toBe('cst.turn');
      expect(turn.channel).toBe('web');
      expect(turn.data.status).toBe('ok');
      expect(turn.data.turn_id).toBe('corr_web_turn_03');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });
  });

  describe('Turn Status Categorization', () => {
    it('publishes onboarding turn when speaker is unknown (!speaker.is_known)', async () => {
      const unknownSpeaker: SpeakerIdentity = {
        person_id: 'unknown_person',
        customer_ref: 'unknown_customer',
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        phone_e164: '+15550009999',
        is_known: false,
        role: 'unknown',
        permissions: [],
        farm_ids: [],
      };

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15550009999',
        text: 'Hello who is this?',
        media: [],
        correlation_id: 'corr_onboarding_turn',
      };

      const res = await CoreEngine.processEnvelope(envelope, unknownSpeaker);
      expect(res.reply_text).toBe(testProject.onboarding_reply);

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('onboarding');
      expect(turn.data.reply_text).toBe(testProject.onboarding_reply);
      expect(turn.customer.is_known).toBe(false);
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('publishes refused turn when role management is attempted', async () => {
      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'change role for user 123 to manager',
        media: [],
        correlation_id: 'corr_refused_role_mgmt',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);
      expect(res.status).toBe('refused');
      expect(res.reply_text).toContain('restricted to the Organization Admin Panel');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('refused');
      expect(turn.data.reason).toContain('User management attempt');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('publishes refused turn when tech role attempts equipment control', async () => {
      const techSpeaker: SpeakerIdentity = {
        ...knownSpeaker,
        role: 'tech',
      };

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'turn off the irrigation pump now',
        media: [],
        correlation_id: 'corr_refused_tech_control',
      };

      const res = await CoreEngine.processEnvelope(envelope, techSpeaker);
      expect(res.status).toBe('refused');
      expect(res.reply_text).toContain("Role 'tech' is not authorized");

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('refused');
      expect(turn.data.reason).toContain('Tech role is not authorized');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('publishes step_up turn when sensitive action requires verification', async () => {
      vi.spyOn(StepUpAuthService, 'isSensitiveAction').mockReturnValue(true);
      vi.spyOn(StepUpAuthService, 'verifyStepUp').mockReturnValue({
        verified: false,
        message: 'Security challenge required: Reply with your 6-digit PIN',
      } as any);

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'override emergency valve',
        media: [],
        correlation_id: 'corr_step_up_turn',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);
      expect(res.status).toBe('step_up_required');
      expect(res.reply_text).toContain('Reply with your 6-digit PIN');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('step_up_required');
      expect(turn.data.reply_text).toContain('Reply with your 6-digit PIN');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('publishes failed turn on unhandled errors/exceptions', async () => {
      vi.spyOn(VfarmConnector, 'getUnitStatus').mockRejectedValue(
        new Error('Database cluster deadlocked')
      );

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'status please',
        media: [],
        correlation_id: 'corr_exception_turn',
      };

      await expect(CoreEngine.processEnvelope(envelope, knownSpeaker)).rejects.toThrow(
        'Database cluster deadlocked'
      );

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('error');
      expect(turn.data.error).toBe('Database cluster deadlocked');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('publishes refused turn when tenant or project is invalid', async () => {
      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-nonexistent',
        project_id: 'proj-nonexistent',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'status please',
        media: [],
        correlation_id: 'corr_invalid_tenant_turn',
      };

      await expect(CoreEngine.processEnvelope(envelope, knownSpeaker)).rejects.toThrow(
        'not found'
      );

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('refused');
      expect(turn.data.error).toContain('not found');
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });
  });

  describe('Exact Turn Invariant: exactly one cst.turn per customer turn', () => {
    it('produces exactly N turns for N sequential customer messages', async () => {
      vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue({
        text: 'Normal',
      } as any);

      const TOTAL_TURNS = 5;
      for (let i = 1; i <= TOTAL_TURNS; i++) {
        const envelope: MessageEnvelope = {
          tenant_id: 'tenant-test-turn',
          project_id: 'proj-test-turn',
          channel: 'sms',
          speaker_ref: '+15559990001',
          text: `status query ${i}`,
          media: [],
          correlation_id: `corr_sequence_${i}`,
        };
        await CoreEngine.processEnvelope(envelope, knownSpeaker);
      }

      expect(publishedEvents).toHaveLength(TOTAL_TURNS);
      const turnIds = publishedEvents.map((e) => e.data.turn_id);
      expect(new Set(turnIds).size).toBe(TOTAL_TURNS);
    });
  });

  describe('Task 4 — Intent/reason enrichment & Complete Turn Row', () => {
    it('ensures refused responses expose intent, reason, and duration_ms', async () => {
      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'grant role to another user',
        media: [],
        correlation_id: 'corr_enrich_refused_01',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);

      // Verify EnvelopeResponse exposures
      expect(res.status).toBe('refused');
      expect(res.intent).toBeDefined();
      expect(typeof res.intent).toBe('string');
      expect(res.reason).toBeDefined();
      expect(res.reason).toContain('User management attempt');
      expect(res.reply).toBe(res.reply_text);
      expect(typeof res.duration_ms).toBe('number');
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);

      // Verify Publisher event enrichment for dashboard Turn row
      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.conversation_id).toBeDefined();
      expect(turn.tenant_id).toBe('tenant-test-turn');
      expect(turn.project_id).toBe('proj-test-turn');
      expect(turn.customer.customer_ref).toBe('cust_turn_owner');
      expect(turn.customer.phone_e164).toBe('+15559990001');
      expect(turn.data.reply).toBe(res.reply_text);
      expect(turn.data.duration_ms).toBe(res.duration_ms);
      expect(turn.data.intent).toBe(res.intent);
      expect(turn.data.reason).toBe(res.reason);

      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('ensures step-up responses expose intent, reason, and duration_ms', async () => {
      vi.spyOn(StepUpAuthService, 'isSensitiveAction').mockReturnValue(true);
      vi.spyOn(StepUpAuthService, 'verifyStepUp').mockReturnValue({
        verified: false,
        message: 'Security challenge: enter passcode',
      } as any);

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'override emergency switch',
        media: [],
        correlation_id: 'corr_enrich_stepup_02',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);

      expect(res.status).toBe('step_up_required');
      expect(res.intent).toBeDefined();
      expect(res.reason).toContain('Sensitive operations require step-up authentication');
      expect(res.reply).toBe('Security challenge: enter passcode');
      expect(typeof res.duration_ms).toBe('number');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('step_up_required');
      expect(turn.data.conversation_id).toBeDefined();
      expect(turn.tenant_id).toBe('tenant-test-turn');
      expect(turn.project_id).toBe('proj-test-turn');
      expect(turn.customer.role).toBe('owner');
      expect(turn.data.reply).toBe('Security challenge: enter passcode');
      expect(turn.data.duration_ms).toBe(res.duration_ms);
      expect(turn.data.intent).toBe(res.intent);
      expect(turn.data.reason).toBe(res.reason);

      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('enriches escalated turns with incident_id and full turn metadata', async () => {
      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'voice',
        speaker_ref: '+15559990001',
        text: 'urgent water leak emergency help',
        media: [],
        correlation_id: 'corr_enrich_escalate_03',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);

      expect(res.intent).toBe('escalate');
      expect(res.incident_id).toBeDefined();
      expect(typeof res.incident_id).toBe('string');
      expect(res.incident_id).toContain('inc_');
      expect(res.reason).toContain('successfully processed');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.status).toBe('ok');
      expect(turn.data.conversation_id).toBe(res.conversation_id);
      expect(turn.tenant_id).toBe('tenant-test-turn');
      expect(turn.project_id).toBe('proj-test-turn');
      expect(turn.customer.customer_ref).toBe('cust_turn_owner');
      expect(turn.data.reply).toBe(res.reply_text);
      expect(turn.data.duration_ms).toBe(res.duration_ms);
      expect(turn.data.incident_id).toBe(res.incident_id);
      expect(turn.data.intent).toBe('escalate');

      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });

    it('never fabricates an incident_id when BHARAG incident creation fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/incidents')) {
          // Upstream 500 — no ticket exists.
          return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
        }
        return { ok: true, json: async () => ({ answer: 'KB answer.' }) } as Response;
      });

      const envelope: MessageEnvelope = {
        tenant_id: 'tenant-test-turn',
        project_id: 'proj-test-turn',
        channel: 'voice',
        speaker_ref: '+15559990001',
        text: 'urgent water leak emergency help',
        media: [],
        correlation_id: 'corr_enrich_escalate_fail',
      };

      const res = await CoreEngine.processEnvelope(envelope, knownSpeaker);

      expect(res.intent).toBe('escalate');
      // No id at all — not a synthetic `inc_vfarm_<hex>`.
      expect(res.incident_id).toBeUndefined();
      expect(res.reply_text).toContain('could not open a support ticket');

      expect(publishedEvents).toHaveLength(1);
      const turn = publishedEvents[0];
      expect(turn.data.incident_id).toBeUndefined();
      expect(turn.data.status).toBe('error');
      expect(turn.data.error).toBeTruthy();
      expect(CstTurnEventV1Schema.safeParse(turn).success).toBe(true);
    });
  });
});
