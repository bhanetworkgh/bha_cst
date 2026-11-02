import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { IdentityResolver } from '../../engine/src/identity/resolver.js';
import { IntentRouter } from '../../engine/src/router/index.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const PHONE = '+15550007777';
const DID = '+19715885823';

function transcriptInput(messageId = 'vmsg_persistence_test') {
  return {
    message_id: messageId,
    conversation_id: 'conv_persistence_test',
    tenant_id: TENANT,
    project_id: PROJECT,
    direction: 'outbound' as const,
    from_e164: DID,
    to_e164: PHONE,
    body: 'Persistence regression response',
    provider_sid: 'VOICE_PERSISTENCE_DB_001',
  };
}

describe('Voice persistence durability and retry safety', () => {
  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    DbClient.setPool(null);
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async () => ({ audioBase64: 'AAAA', mimeType: 'audio/mpeg' })),
    });
    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue({
      reply_text: 'Persistence regression response',
      status: 'ok',
      conversation_id: 'conv_persistence_test',
      metadata: { conversation_id: 'conv_persistence_test' },
    } as any);
  });

  afterEach(() => {
    DbClient.setPool(null);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('rejects a PostgreSQL transcript failure instead of exposing in-memory success', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('transcript insert failed')) };
    DbClient.setPool(pool as any);

    await expect(DbClient.addMessageToTranscript(transcriptInput())).rejects.toMatchObject({
      code: 'TRANSCRIPT_PERSISTENCE_FAILED',
    });
    expect(DbClient.getAllTranscripts()).toHaveLength(0);
  });

  it('rejects a PostgreSQL voice-delivery failure instead of exposing in-memory success', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM systems')) return { rows: [{ system_id: 'system-vfarm-01' }] };
        if (sql.includes('INSERT INTO voice_deliveries')) throw new Error('delivery insert failed');
        return { rows: [] };
      }),
    };
    DbClient.setPool(pool as any);

    await expect(DbClient.recordVoiceDelivery({
      tenant_id: TENANT,
      project_id: PROJECT,
      status: 'synthesized',
      character_count: 10,
      audio_bytes: 2,
      correlation_id: 'VOICE_DELIVERY_DB_001',
    })).rejects.toMatchObject({ code: 'VOICE_DELIVERY_PERSISTENCE_FAILED' });
    expect(DbClient.getAllVoiceDeliveries()).toHaveLength(0);
  });

  it('returns persistence failure and records no synthesized delivery when the transcript fails', async () => {
    vi.spyOn(DbClient, 'addMessageToTranscript').mockRejectedValue(new Error('transcript unavailable'));
    const deliverySpy = vi.spyOn(DbClient, 'recordVoiceDelivery');

    const result = await VoiceInterface.processVoiceTurn({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'VOICE_TRANSCRIPT_FAIL_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('VOICE_PERSISTENCE_FAILED');
    expect(result.httpStatus).toBe(500);
    expect(deliverySpy).not.toHaveBeenCalled();
    expect(DbClient.getAllVoiceDeliveries()).toHaveLength(0);
  });

  it('returns persistence failure when the voice-delivery write fails after synthesis', async () => {
    vi.spyOn(DbClient, 'recordVoiceDelivery').mockRejectedValue(new Error('delivery unavailable'));

    const result = await VoiceInterface.processVoiceTurn({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'VOICE_DELIVERY_FAIL_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('VOICE_PERSISTENCE_FAILED');
    expect(result.httpStatus).toBe(500);
  });

  it('deduplicates transcript and delivery rows when the same voice turn is retried', async () => {
    const input = {
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'VOICE_RETRY_001',
    };

    const first = await VoiceInterface.processVoiceTurn(input);
    const second = await VoiceInterface.processVoiceTurn(input);

    expect(first.status).toBe('synthesized');
    expect(second.status).toBe('synthesized');
    expect(second.message_id).toBe(first.message_id);
    expect(DbClient.getAllTranscripts().filter(
      (row) => row.provider_sid === input.correlation_id && row.direction === 'outbound',
    )).toHaveLength(1);
    expect(DbClient.getAllVoiceDeliveries().filter(
      (row) => row.correlation_id === input.correlation_id,
    )).toHaveLength(1);
  });

  it('persists one transcript and one delivery for a successful local voice turn', async () => {
    const result = await VoiceInterface.processVoiceTurn({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'VOICE_SUCCESS_001',
    });

    expect(result.status).toBe('synthesized');
    expect(DbClient.getAllTranscripts().filter(
      (row) => row.provider_sid === 'VOICE_SUCCESS_001' && row.direction === 'outbound',
    )).toHaveLength(1);
    expect(DbClient.getAllVoiceDeliveries().filter(
      (row) => row.correlation_id === 'VOICE_SUCCESS_001' && row.status === 'synthesized',
    )).toHaveLength(1);
  });
});

describe('Voice Lane persistence durability and retry safety', () => {
  const LANE_PHONE = '+15550008888';
  const LANE_CUSTOMER = 'cust_voice_lane_persistence';

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    DbClient.setPool(null);
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
    VoiceLaneService.setSynthesizer({
      synthesize: vi.fn(async () => ({ audioBase64: 'AAAA', mimeType: 'audio/mpeg' })),
    });
    DbClient.seedConversation({
      conversation_id: 'conv_voice_lane_persistence',
      tenant_id: TENANT,
      project_id: PROJECT,
      customer_ref: LANE_CUSTOMER,
    });
    vi.spyOn(IdentityResolver, 'resolveSenderIdentity').mockReturnValue({
      customer_ref: LANE_CUSTOMER,
      role: 'manager',
      permissions: [],
      farm_ids: [],
      is_known: true,
    } as any);
    vi.spyOn(IntentRouter, 'routeAndHandle').mockImplementation(async (msg: any) => ({
      id: `out_${msg.correlation_id}`,
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: msg.from_e164,
      body: 'Voice Lane persistence response',
      status: 'pending',
      correlation_id: msg.correlation_id,
    } as any));
  });

  afterEach(() => {
    VoiceLaneService.setSynthesizer(null);
    DbClient.setPool(null);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('fails closed and records no synthesized delivery when Voice Lane transcript persistence fails', async () => {
    vi.spyOn(DbClient, 'addMessageToTranscript').mockRejectedValue(new Error('lane transcript unavailable'));
    const deliverySpy = vi.spyOn(DbClient, 'recordVoiceDelivery');

    const result = await VoiceLaneService.processVoiceTurn({
      from_e164: LANE_PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LANE_TRANSCRIPT_FAIL_001',
    });

    expect(result.status).toBe('failed');
    expect((result as any).error).toBe('VOICE_PERSISTENCE_FAILED');
    expect(deliverySpy).not.toHaveBeenCalled();
    expect(DbClient.getAllVoiceDeliveries()).toHaveLength(0);
  });

  it('deduplicates Voice Lane transcript and delivery rows when the same turn is retried', async () => {
    const input = {
      from_e164: LANE_PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LANE_RETRY_001',
    };

    const first = await VoiceLaneService.processVoiceTurn(input);
    const second = await VoiceLaneService.processVoiceTurn(input);

    expect(first.status).toBe('synthesized');
    expect(second.status).toBe('synthesized');
    expect(second.message_id).toBe(first.message_id);
    expect(DbClient.getAllTranscripts().filter(
      (row) => row.provider_sid === input.correlation_id && row.direction === 'outbound',
    )).toHaveLength(1);
    expect(DbClient.getAllVoiceDeliveries().filter(
      (row) => row.correlation_id === input.correlation_id,
    )).toHaveLength(1);
  });
});
