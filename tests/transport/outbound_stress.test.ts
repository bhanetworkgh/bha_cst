import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';

describe('Outbound Queue Concurrency and Stress Testing', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    // Outbound SMS is authorized only via project -> service_number_binding, so
    // the registry must hold the tenant/project + bound SMS number these tests send from.
    CoreRegistry.resetToDefault();
    TwilioClientWrapper.setMockHandler(null);
  });

  it('Stress Test: processes 1000 queued messages across concurrent workers with zero duplicate sends', async () => {
    const QUEUE_SIZE = 1000;
    const NUM_WORKERS = 10;

    // Track every send attempt and successful send by message ID
    const sendAttemptsByMsgId = new Map<string, number>();
    const successfulSendsByMsgId = new Map<string, number>();

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      // Extract the msg id encoded in the body
      const msgId = params.body.split(':')[0];

      sendAttemptsByMsgId.set(msgId, (sendAttemptsByMsgId.get(msgId) || 0) + 1);

      // Simulate slight variable async I/O latency to exercise race windows
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));

      successfulSendsByMsgId.set(msgId, (successfulSendsByMsgId.get(msgId) || 0) + 1);
      return { sid: `SM_MOCK_${msgId}`, status: 'sent' };
    });

    // Seed 1000 pending outbound messages
    const seededIds: string[] = [];
    for (let i = 0; i < QUEUE_SIZE; i++) {
      const id = `msg_stress_${String(i).padStart(4, '0')}`;
      seededIds.push(id);
      await DbClient.saveOutboundMessage({
        id,
        tenant_id: 'tenant-vfarm-01',
        // Outbound sends are authorized ONLY through project -> service_number_binding.
        project_id: 'proj-vfarm-main',
        to_e164: `+1555${String(1000000 + i)}`,
        body: `${id}: Stress test message payload ${i}`,
        correlation_id: `corr_stress_${i}`,
        status: 'pending',
      });
    }

    expect(seededIds.length).toBe(QUEUE_SIZE);

    // Run multiple workers concurrently processing the queue until all are handled
    const runWorker = async (workerId: number) => {
      while (true) {
        const pending = await DbClient.getPendingOutboundMessages();
        if (pending.length === 0) {
          break;
        }
        await processOutboundQueue();
        // Yield to allow other workers to interleave
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    const workers = Array.from({ length: NUM_WORKERS }, (_, i) => runWorker(i));
    await Promise.all(workers);

    // Assertions on sends
    const uniqueSends = successfulSendsByMsgId.size;
    let duplicateSends = 0;
    for (const [msgId, count] of successfulSendsByMsgId.entries()) {
      if (count > 1) {
        duplicateSends += count - 1;
      }
    }

    console.log(`Stress Test Results:`);
    console.log(`  Queued messages:  ${QUEUE_SIZE}`);
    console.log(`  Unique sends:     ${uniqueSends}`);
    console.log(`  Duplicate sends:  ${duplicateSends}`);

    expect(uniqueSends).toBe(QUEUE_SIZE);
    expect(duplicateSends).toBe(0);

    // Verify all messages are marked 'sent' in database
    const allOut = DbClient.getAllMessagesOut();
    expect(allOut.length).toBe(QUEUE_SIZE);
    for (const msg of allOut) {
      expect(msg.status).toBe('sent');
      expect(msg.provider_sid).toBe(`SM_MOCK_${msg.id}`);
    }
  }, 30000);

  it('Race Test: multiple workers racing simultaneously to process the same queue item results in zero duplicate sends', async () => {
    const NUM_RACING_WORKERS = 10;
    const msgId = 'msg_race_single_001';

    const sendCountMap = new Map<string, number>();

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      // Simulate non-zero async latency during Twilio send
      await new Promise((resolve) => setTimeout(resolve, 10));
      sendCountMap.set(params.to, (sendCountMap.get(params.to) || 0) + 1);
      return { sid: `SM_RACE_${msgId}`, status: 'sent' };
    });

    await DbClient.saveOutboundMessage({
      id: msgId,
      tenant_id: 'tenant-vfarm-01',
      // Outbound sends are authorized ONLY through the project -> service_number_binding
      // chain, so queued messages must carry the project that owns the sending DID.
      project_id: 'proj-vfarm-main',
      to_e164: '+15559876543',
      body: `${msgId}: Single race item`,
      correlation_id: 'corr_race_single_001',
      status: 'pending',
    });

    // Launch all workers simultaneously against the single queue item
    await Promise.all(Array.from({ length: NUM_RACING_WORKERS }, () => processOutboundQueue()));

    const sendsForDest = sendCountMap.get('+15559876543') || 0;
    console.log(`Single item race sends: ${sendsForDest}`);

    expect(sendsForDest).toBe(1);

    const record = DbClient.getAllMessagesOut().find((m) => m.id === msgId);
    expect(record?.status).toBe('sent');
    expect(record?.provider_sid).toBe(`SM_RACE_${msgId}`);
  });

  it('Race Test: direct atomic claim race condition on identical message ID - exactly one worker wins claim and sends', async () => {
    const msgId = 'msg_race_direct_claim_001';

    await DbClient.saveOutboundMessage({
      id: msgId,
      tenant_id: 'tenant-vfarm-01',
      // Outbound sends are authorized ONLY through the project -> service_number_binding
      // chain, so queued messages must carry the project that owns the sending DID.
      project_id: 'proj-vfarm-main',
      to_e164: '+15554445555',
      body: `${msgId}: Direct atomic claim race item`,
      correlation_id: 'corr_race_direct_claim',
      status: 'pending',
    });

    // 20 simulated workers all racing to claim the exact same item ID simultaneously
    const claimResults = await Promise.all(
      Array.from({ length: 20 }, () => DbClient.claimOutboundMessage(msgId))
    );

    const successfulClaims = claimResults.filter((r) => r === true).length;
    const rejectedClaims = claimResults.filter((r) => r === false).length;

    expect(successfulClaims).toBe(1);
    expect(rejectedClaims).toBe(19);

    const record = DbClient.getAllMessagesOut().find((m) => m.id === msgId);
    expect(record?.status).toBe('sending');
  });

  it('Race Test: concurrent workers racing on eligible queued retry items results in zero duplicate sends', async () => {
    const NUM_RETRY_ITEMS = 50;
    const NUM_WORKERS = 8;
    const successfulSendsByMsgId = new Map<string, number>();

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      const msgId = params.body.split(':')[0];
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
      successfulSendsByMsgId.set(msgId, (successfulSendsByMsgId.get(msgId) || 0) + 1);
      return { sid: `SM_RETRY_MOCK_${msgId}`, status: 'sent' };
    });

    // Seed 50 queued retry items whose next_retry_at is in the past
    for (let i = 0; i < NUM_RETRY_ITEMS; i++) {
      const id = `msg_retry_race_${String(i).padStart(3, '0')}`;
      await DbClient.saveOutboundMessage({
        id,
        tenant_id: 'tenant-vfarm-01',
        // Outbound sends are authorized ONLY through project -> service_number_binding.
        project_id: 'proj-vfarm-main',
        to_e164: `+15552000${String(i).padStart(3, '0')}`,
        body: `${id}: Retry race payload ${i}`,
        correlation_id: `corr_retry_race_${i}`,
        status: 'queued',
        retry_count: 1,
        next_retry_at: new Date(Date.now() - 5000).toISOString(), // Eligible for immediate processing
      });
    }

    const runWorker = async () => {
      while (true) {
        const pending = await DbClient.getPendingOutboundMessages();
        if (pending.length === 0) break;
        await processOutboundQueue();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    await Promise.all(Array.from({ length: NUM_WORKERS }, () => runWorker()));

    expect(successfulSendsByMsgId.size).toBe(NUM_RETRY_ITEMS);

    let duplicates = 0;
    for (const count of successfulSendsByMsgId.values()) {
      if (count > 1) duplicates += count - 1;
    }
    expect(duplicates).toBe(0);
  });

  it('Retry Test: temporary Twilio failure retries and succeeds without duplicate sends', async () => {
    const msgId = 'msg_retry_temp_fail_001';
    let attempts = 0;
    const successfulSends: string[] = [];

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Twilio 503 Service Unavailable (temporary)');
      }
      successfulSends.push(params.to);
      return { sid: `SM_RETRY_SUCCESS_${msgId}`, status: 'sent' };
    });

    await DbClient.saveOutboundMessage({
      id: msgId,
      tenant_id: 'tenant-vfarm-01',
      // Outbound sends are authorized ONLY through the project -> service_number_binding
      // chain, so queued messages must carry the project that owns the sending DID.
      project_id: 'proj-vfarm-main',
      to_e164: '+15551112233',
      body: `${msgId}: Temporary failure retry test`,
      correlation_id: 'corr_retry_temp_fail',
      status: 'pending',
      max_retries: 3,
    });

    await processOutboundQueue();

    expect(attempts).toBe(2);
    expect(successfulSends.length).toBe(1);

    const record = DbClient.getAllMessagesOut().find((m) => m.id === msgId);
    expect(record?.status).toBe('sent');
    expect(record?.retry_count).toBe(2);
    expect(record?.provider_sid).toBe(`SM_RETRY_SUCCESS_${msgId}`);
  });

  it('Retry Test: permanent Twilio non-retriable failure fails immediately and is not retried', async () => {
    const msgId = 'msg_retry_perm_fail_001';
    let attempts = 0;

    TwilioClientWrapper.setMockHandler(async () => {
      attempts++;
      const err: any = new Error('Invalid To Phone Number');
      err.code = 21211; // Non-retriable Twilio error code
      err.isNonRetriable = true;
      throw err;
    });

    await DbClient.saveOutboundMessage({
      id: msgId,
      tenant_id: 'tenant-vfarm-01',
      // Outbound sends are authorized ONLY through the project -> service_number_binding
      // chain, so queued messages must carry the project that owns the sending DID.
      project_id: 'proj-vfarm-main',
      to_e164: '+15550009999',
      body: `${msgId}: Permanent failure test`,
      correlation_id: 'corr_retry_perm_fail',
      status: 'pending',
      max_retries: 3,
    });

    await processOutboundQueue();

    // Should stop retrying immediately on non-retriable error
    expect(attempts).toBe(1);

    const record = DbClient.getAllMessagesOut().find((m) => m.id === msgId);
    expect(record?.status).toBe('failed');
  });

  it('Retry Test: exhausted retries marks message as failed with zero successful sends', async () => {
    const msgId = 'msg_retry_exhaust_001';
    let attempts = 0;
    const successfulSends: string[] = [];

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      attempts++;
      throw new Error('Persistent network connection error');
    });

    await DbClient.saveOutboundMessage({
      id: msgId,
      tenant_id: 'tenant-vfarm-01',
      // Outbound sends are authorized ONLY through the project -> service_number_binding
      // chain, so queued messages must carry the project that owns the sending DID.
      project_id: 'proj-vfarm-main',
      to_e164: '+15553334444',
      body: `${msgId}: Exhausted retries test`,
      correlation_id: 'corr_retry_exhaust',
      status: 'pending',
      max_retries: 3,
    });

    await processOutboundQueue();

    expect(attempts).toBe(3);
    expect(successfulSends.length).toBe(0);

    const record = DbClient.getAllMessagesOut().find((m) => m.id === msgId);
    expect(record?.status).toBe('failed');
  });
});
