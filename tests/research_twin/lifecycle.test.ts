import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryResearchTwinInvestigationStore,
  ProvisionalResearchTwinLifecycle,
  ResearchTwinLifecycleError,
  ResearchTwinTransportError,
  type ProvisionalResearchTwinTransport,
  type ResearchTwinExternalUpdate,
  type ResearchTwinInvestigationRequest,
} from '../../engine/src/research_twin/lifecycle.js';

const NOW = '2026-11-02T12:00:00.000Z';

function request(overrides: Partial<ResearchTwinInvestigationRequest> = {}): ResearchTwinInvestigationRequest {
  return {
    tenant_id: 'tenant-test',
    project_id: 'project-test',
    correlation_id: 'correlation-test',
    source_system: 'bha-cst',
    originating_incident_id: 'incident-test',
    occurred_at: '2026-11-02T11:59:59.000Z',
    event_type: 'operational_incident',
    priority: 'opaque-priority-fixture',
    idempotency_key: 'idempotency-test',
    ...overrides,
  };
}

function externalUpdate(
  overrides: Partial<ResearchTwinExternalUpdate> = {},
): ResearchTwinExternalUpdate {
  return {
    tenant_id: 'tenant-test',
    project_id: 'project-test',
    research_twin_investigation_id: 'external-investigation-test',
    external_event_id: 'external-event-1',
    event_type: 'opaque_external_event',
    assignment: 'external-assignee-fixture',
    lifecycle_status: 'opaque-lifecycle-fixture',
    observed_at: NOW,
    ...overrides,
  };
}

function harness(
  transport: ProvisionalResearchTwinTransport,
  options: { maxAttempts?: number; sleep?: (delayMs: number) => Promise<void> } = {},
) {
  const store = new InMemoryResearchTwinInvestigationStore();
  const lifecycle = new ProvisionalResearchTwinLifecycle({
    transport,
    store,
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    sleep: options.sleep ?? (async () => {}),
    now: () => new Date(NOW),
    createInternalId: () => 'internal-investigation-test',
  });
  return { lifecycle, store };
}

describe('provisional Research Twin lifecycle', () => {
  it('persists the authoritative external ID with tenant, project and correlation context', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle } = harness(transport);

    const result = await lifecycle.createInvestigation(request());

    expect(result.duplicate).toBe(false);
    expect(result.transport_attempted).toBe(true);
    expect(result.record).toMatchObject({
      ...request(),
      internal_investigation_id: 'internal-investigation-test',
      research_twin_investigation_id: 'external-investigation-test',
      creation_state: 'created',
      creation_attempts: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(transport.createInvestigation).toHaveBeenCalledWith(request());
  });

  it('uses tenant/project-scoped idempotency and does not create a duplicate card', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle } = harness(transport);

    const first = await lifecycle.createInvestigation(request());
    const second = await lifecycle.createInvestigation(request());

    expect(second.duplicate).toBe(true);
    expect(second.transport_attempted).toBe(false);
    expect(second.record.research_twin_investigation_id).toBe(first.record.research_twin_investigation_id);
    expect(transport.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it('allows the same idempotency key in a different tenant scope', async () => {
    const transport = {
      createInvestigation: vi
        .fn()
        .mockResolvedValueOnce({ investigation_id: 'external-investigation-test' })
        .mockResolvedValueOnce({ investigation_id: 'external-investigation-other-tenant' }),
    };
    const { lifecycle } = harness(transport);

    await lifecycle.createInvestigation(request());
    const other = await lifecycle.createInvestigation(request({ tenant_id: 'tenant-other' }));

    expect(other.record.research_twin_investigation_id).toBe('external-investigation-other-tenant');
    expect(transport.createInvestigation).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent creation attempts', async () => {
    let release!: (value: { investigation_id: string }) => void;
    const transport = {
      createInvestigation: vi.fn(
        () => new Promise<{ investigation_id: string }>((resolve) => { release = resolve; }),
      ),
    };
    const { lifecycle } = harness(transport);

    const firstPromise = lifecycle.createInvestigation(request());
    const second = await lifecycle.createInvestigation(request());
    release({ investigation_id: 'external-investigation-test' });
    const first = await firstPromise;

    expect(second.transport_attempted).toBe(false);
    expect(second.record.creation_state).toBe('creating');
    expect(first.record.creation_state).toBe('created');
    expect(transport.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it('retries only transient failures with bounded exponential backoff', async () => {
    const delays: number[] = [];
    const transport = {
      createInvestigation: vi
        .fn()
        .mockRejectedValueOnce(new ResearchTwinTransportError('temporary_unavailable', true))
        .mockRejectedValueOnce(new ResearchTwinTransportError('temporary_timeout', true))
        .mockResolvedValueOnce({ investigation_id: 'external-investigation-test' }),
    };
    const { lifecycle } = harness(transport, {
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    const result = await lifecycle.createInvestigation(request());

    expect(result.record.creation_attempts).toBe(3);
    expect(result.record.creation_state).toBe('created');
    expect(delays).toEqual([10, 20]);
    expect(transport.createInvestigation).toHaveBeenCalledTimes(3);
  });

  it('stops transient retries at the configured bound and permits a later explicit retry', async () => {
    const transport = {
      createInvestigation: vi.fn(async () => {
        throw new ResearchTwinTransportError('temporary_unavailable', true);
      }),
    };
    const sleep = vi.fn(async () => {});
    const { lifecycle } = harness(transport, { maxAttempts: 2, sleep });

    await expect(lifecycle.createInvestigation(request())).rejects.toMatchObject({
      code: 'temporary_unavailable',
    });
    expect(transport.createInvestigation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);

    transport.createInvestigation.mockResolvedValueOnce({ investigation_id: 'external-investigation-test' });
    const retry = await lifecycle.createInvestigation(request());
    expect(retry.transport_attempted).toBe(true);
    expect(retry.record.creation_state).toBe('created');
    expect(retry.record.creation_attempts).toBe(3);
    expect(transport.createInvestigation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent transport failure on later calls', async () => {
    const transport = {
      createInvestigation: vi.fn(async () => {
        throw new ResearchTwinTransportError('authentication_rejected', false);
      }),
    };
    const { lifecycle } = harness(transport);

    await expect(lifecycle.createInvestigation(request())).rejects.toMatchObject({
      code: 'authentication_rejected',
    });
    const second = await lifecycle.createInvestigation(request());

    expect(second.transport_attempted).toBe(false);
    expect(second.record.creation_state).toBe('blocked_permanent_failure');
    expect(second.record.last_error_code).toBe('authentication_rejected');
    expect(transport.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a response without an investigation ID for card creation', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: '' })) };
    const { lifecycle } = harness(transport);

    await expect(lifecycle.createInvestigation(request())).rejects.toMatchObject({
      code: 'invalid_creation_response',
      retryable: false,
    });
    expect(transport.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it('applies opaque assignment and lifecycle snapshots and deduplicates events', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle, store } = harness(transport);
    await lifecycle.createInvestigation(request());

    const assignment = await lifecycle.applyExternalUpdate(externalUpdate());
    const duplicate = await lifecycle.applyExternalUpdate(externalUpdate());
    const resolution = await lifecycle.applyExternalUpdate(externalUpdate({
      external_event_id: 'external-event-2',
      assignment: null,
      lifecycle_status: 'opaque-terminal-lifecycle-fixture',
      observed_at: '2026-11-02T12:05:00.000Z',
    }));
    const events = await store.listExternalEvents(
      'tenant-test',
      'project-test',
      'external-investigation-test',
    );

    expect(assignment.duplicate).toBe(false);
    expect(assignment.record.assignment).toBe('external-assignee-fixture');
    expect(duplicate.duplicate).toBe(true);
    expect(resolution.record.lifecycle_status).toBe('opaque-terminal-lifecycle-fixture');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.external_event_id)).toEqual(['external-event-1', 'external-event-2']);
    expect(transport.createInvestigation).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown investigation IDs and wrong tenant/project scope', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle } = harness(transport);
    await lifecycle.createInvestigation(request());

    await expect(lifecycle.applyExternalUpdate(externalUpdate({
      research_twin_investigation_id: 'unknown-external-id',
    }))).rejects.toMatchObject({ code: 'unknown_investigation' });
    await expect(lifecycle.applyExternalUpdate(externalUpdate({ tenant_id: 'tenant-other' })))
      .rejects.toMatchObject({ code: 'unknown_investigation' });
    await expect(lifecycle.applyExternalUpdate(externalUpdate({ project_id: 'project-other' })))
      .rejects.toMatchObject({ code: 'unknown_investigation' });
  });

  it('rejects invalid lifecycle event input before persistence', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle } = harness(transport);
    await lifecycle.createInvestigation(request());

    await expect(lifecycle.applyExternalUpdate(externalUpdate({ external_event_id: '' })))
      .rejects.toBeInstanceOf(ResearchTwinLifecycleError);
    await expect(lifecycle.applyExternalUpdate(externalUpdate({ observed_at: 'not-a-timestamp' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects missing tenant/project/correlation context before transport', async () => {
    const transport = { createInvestigation: vi.fn(async () => ({ investigation_id: 'external-investigation-test' })) };
    const { lifecycle } = harness(transport);

    await expect(lifecycle.createInvestigation(request({ tenant_id: '' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(lifecycle.createInvestigation(request({ project_id: '' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(lifecycle.createInvestigation(request({ correlation_id: '' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(transport.createInvestigation).not.toHaveBeenCalled();
  });
});
