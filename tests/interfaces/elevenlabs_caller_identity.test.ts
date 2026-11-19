import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { DbClient } from '../../engine/src/db/client.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';

vi.mock('../../engine/src/db/client.js', () => ({ DbClient: {
  recordRequiredDashboardOutcomes: vi.fn().mockResolvedValue(undefined),
  recordDashboardPublishOutcome: vi.fn().mockResolvedValue(undefined),
  createEscalationRecord: vi.fn().mockResolvedValue('escl_test'),
} }));
vi.mock('../../engine/src/notifications/error_router.js', () => ({ ErrorRouter: {
  route: vi.fn().mockResolvedValue({ dispatched: true }),
} }));
vi.mock('../../engine/src/observability/failure_detector.js', () => ({
  FailureDetector: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock('../../engine/src/observability/cut_over.js', () => ({
  CutOverManager: { isEventEligible: () => ({ eligible: true }) },
}));
const { publish } = vi.hoisted(() => ({ publish: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../../engine/src/publishers/dashboard.js', () => ({ getDashboardPublisher: () => ({ publish }) }));

function payload(metadata: Record<string, unknown> = {}) {
  return {
    conversation_id: 'conv_identity_test',
    start_time_unix_secs: 1794000000,
    metadata,
    transcript: [{ role: 'user', message: 'Please help with my rack' }],
  } as Parameters<typeof ElevenLabsWebhookService.process>[0];
}

describe('SO8M provider caller identity', () => {
  beforeEach(() => { vi.clearAllMocks(); ElevenLabsWebhookService.reset(); });

  it.each([
    { custom_variables: { caller_phone: '+12025550123' } },
    { phone_call: { external_number: '+12025550123' } },
    { caller_id: '+12025550123' },
  ])('preserves a valid supplied number: %j', async (metadata) => {
    expect((await ElevenLabsWebhookService.process(payload(metadata))).status).toBe('processed');
    const events = ElevenLabsWebhookService.getPersistedEvents();
    expect(events).toHaveLength(3);
    expect(DbClient.recordRequiredDashboardOutcomes).toHaveBeenCalledOnce();
    const [outcomes] = vi.mocked(DbClient.recordRequiredDashboardOutcomes).mock.calls[0];
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect((outcome.payload as any).customer.phone_e164).toBe('+12025550123');
    }
    for (const event of events) expect(event.customer?.phone_e164).toBe('+12025550123');
    expect(publish).toHaveBeenCalledOnce();
    expect(ErrorRouter.route).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, '', ' ', 'anonymous', '12025550123', '+012345', '+1234567890123456', 12025550123, {}])(
    'rejects missing/malformed caller %j before side effects', async (value) => {
      const result = await ElevenLabsWebhookService.process(payload({ caller_id: value }));
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/^CALLER_IDENTITY_(MISSING|INVALID)$/);
      expect(result.event_ids).toEqual([]);
      expect(ElevenLabsWebhookService.getPersistedEvents()).toEqual([]);
      expect(DbClient.recordDashboardPublishOutcome).not.toHaveBeenCalled();
      expect(DbClient.recordRequiredDashboardOutcomes).not.toHaveBeenCalled();
      expect(DbClient.createEscalationRecord).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(ErrorRouter.route).not.toHaveBeenCalled();
    });

  it('does not silently replace an invalid higher-priority identity', async () => {
    const result = await ElevenLabsWebhookService.process(payload({
      custom_variables: { caller_phone: 'anonymous' },
      phone_call: { external_number: '+12025550123' },
    }));
    expect(result.error).toBe('CALLER_IDENTITY_INVALID');
  });

  it('permits a corrected retry and still deduplicates a successful delivery', async () => {
    expect((await ElevenLabsWebhookService.process(payload())).status).toBe('failed');
    const corrected = payload({ caller_id: '+12025550123' });
    expect((await ElevenLabsWebhookService.process(corrected)).status).toBe('processed');
    expect((await ElevenLabsWebhookService.process(corrected)).status).toBe('already_processed');
    expect(DbClient.recordRequiredDashboardOutcomes).toHaveBeenCalledOnce();
    expect(ErrorRouter.route).toHaveBeenCalledOnce();
  });
});
