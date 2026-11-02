import { randomUUID } from 'crypto';

/**
 * Contract-independent Research Twin lifecycle infrastructure.
 *
 * This module is explicitly provisional. It defines no HTTP method, payload,
 * authentication header, callback signature, external status vocabulary, or
 * priority mapping. A real transport and durable store require the approved
 * Destiny Arupi / Jeganathan contract. The in-memory store is a deterministic
 * test reference, not production persistence.
 */

export interface ResearchTwinInvestigationRequest {
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  source_system: string;
  originating_incident_id: string;
  /** Authoritative source-observation time supplied by the CST incident. */
  occurred_at: string;
  event_type: string;
  /** Opaque caller-supplied value; CST does not map or interpret it here. */
  priority: string | null;
  idempotency_key: string;
}

export interface ProvisionalResearchTwinTransport {
  createInvestigation(
    request: ResearchTwinInvestigationRequest,
  ): Promise<{ investigation_id: string }>;
}

/** CST-owned submission state; these are not Research Twin lifecycle values. */
export type ResearchTwinCreationState =
  | 'pending'
  | 'creating'
  | 'awaiting_retry'
  | 'blocked_permanent_failure'
  | 'created';

export interface ResearchTwinInvestigationRecord extends ResearchTwinInvestigationRequest {
  internal_investigation_id: string;
  research_twin_investigation_id: string | null;
  creation_state: ResearchTwinCreationState;
  creation_attempts: number;
  last_error_code: string | null;
  assignment: string | null;
  /** Opaque external value; no CST status mapping is applied. */
  lifecycle_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchTwinExternalUpdate {
  tenant_id: string;
  project_id: string;
  research_twin_investigation_id: string;
  external_event_id: string;
  event_type: string;
  assignment: string | null;
  lifecycle_status: string | null;
  observed_at: string;
}

export interface ResearchTwinLifecycleEvent extends ResearchTwinExternalUpdate {
  received_at: string;
}

export interface ResearchTwinInvestigationStore {
  reserve(
    request: ResearchTwinInvestigationRequest,
    record: ResearchTwinInvestigationRecord,
  ): Promise<{ record: ResearchTwinInvestigationRecord; created: boolean }>;
  startCreation(
    internalInvestigationId: string,
  ): Promise<{ record: ResearchTwinInvestigationRecord; started: boolean }>;
  recordCreationAttempt(internalInvestigationId: string): Promise<void>;
  completeCreation(
    internalInvestigationId: string,
    researchTwinInvestigationId: string,
    timestamp: string,
  ): Promise<ResearchTwinInvestigationRecord>;
  failCreation(
    internalInvestigationId: string,
    errorCode: string,
    terminal: boolean,
    retryable: boolean,
    timestamp: string,
  ): Promise<void>;
  applyExternalEvent(
    event: ResearchTwinLifecycleEvent,
  ): Promise<{ record: ResearchTwinInvestigationRecord; duplicate: boolean }>;
  listExternalEvents(
    tenantId: string,
    projectId: string,
    researchTwinInvestigationId: string,
  ): Promise<ResearchTwinLifecycleEvent[]>;
}

export interface ResearchTwinCreateResult {
  record: ResearchTwinInvestigationRecord;
  duplicate: boolean;
  transport_attempted: boolean;
}

export class ResearchTwinTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(`Provisional Research Twin transport failed: ${code}`);
    this.name = 'ResearchTwinTransportError';
  }
}

export class ResearchTwinLifecycleError extends Error {
  constructor(public readonly code: 'invalid_input' | 'unknown_investigation') {
    super(`Research Twin lifecycle operation rejected: ${code}`);
    this.name = 'ResearchTwinLifecycleError';
  }
}

interface LifecycleOptions {
  transport: ProvisionalResearchTwinTransport;
  store: ResearchTwinInvestigationStore;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
  createInternalId?: () => string;
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRequest(request: ResearchTwinInvestigationRequest): void {
  const required: Array<keyof ResearchTwinInvestigationRequest> = [
    'tenant_id',
    'project_id',
    'correlation_id',
    'source_system',
    'originating_incident_id',
    'occurred_at',
    'event_type',
    'idempotency_key',
  ];
  if (
    required.some((field) => !requiredString(request[field])) ||
    !Number.isFinite(Date.parse(request.occurred_at)) ||
    !(request.priority === null || requiredString(request.priority))
  ) {
    throw new ResearchTwinLifecycleError('invalid_input');
  }
}

function validateExternalUpdate(update: ResearchTwinExternalUpdate): void {
  if (
    !requiredString(update.tenant_id) ||
    !requiredString(update.project_id) ||
    !requiredString(update.research_twin_investigation_id) ||
    !requiredString(update.external_event_id) ||
    !requiredString(update.event_type) ||
    !requiredString(update.observed_at) ||
    !Number.isFinite(Date.parse(update.observed_at)) ||
    !(update.assignment === null || typeof update.assignment === 'string') ||
    !(update.lifecycle_status === null || typeof update.lifecycle_status === 'string')
  ) {
    throw new ResearchTwinLifecycleError('invalid_input');
  }
}

function errorCode(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ResearchTwinTransportError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: 'unclassified_transport_failure', retryable: false };
}

export class ProvisionalResearchTwinLifecycle {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly createInternalId: () => string;

  constructor(private readonly options: LifecycleOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? (() => new Date());
    this.createInternalId = options.createInternalId ?? randomUUID;
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      !Number.isFinite(this.baseDelayMs) ||
      this.baseDelayMs < 0 ||
      !Number.isFinite(this.maxDelayMs) ||
      this.maxDelayMs < this.baseDelayMs
    ) {
      throw new ResearchTwinLifecycleError('invalid_input');
    }
  }

  async createInvestigation(request: ResearchTwinInvestigationRequest): Promise<ResearchTwinCreateResult> {
    validateRequest(request);
    const timestamp = this.now().toISOString();
    const reservation = await this.options.store.reserve(request, {
      ...request,
      internal_investigation_id: this.createInternalId(),
      research_twin_investigation_id: null,
      creation_state: 'pending',
      creation_attempts: 0,
      last_error_code: null,
      assignment: null,
      lifecycle_status: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const duplicate = !reservation.created;
    if (
      reservation.record.creation_state === 'created' ||
      reservation.record.creation_state === 'creating' ||
      reservation.record.creation_state === 'blocked_permanent_failure'
    ) {
      return { record: reservation.record, duplicate, transport_attempted: false };
    }

    const start = await this.options.store.startCreation(reservation.record.internal_investigation_id);
    if (!start.started) {
      return { record: start.record, duplicate: true, transport_attempted: false };
    }
    const started = start.record;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.options.store.recordCreationAttempt(started.internal_investigation_id);
      try {
        const response = await this.options.transport.createInvestigation(request);
        if (!requiredString(response?.investigation_id)) {
          throw new ResearchTwinTransportError('invalid_creation_response', false);
        }
        const record = await this.options.store.completeCreation(
          started.internal_investigation_id,
          response.investigation_id,
          this.now().toISOString(),
        );
        return { record, duplicate, transport_attempted: true };
      } catch (error) {
        const failure = errorCode(error);
        const terminal = attempt === this.maxAttempts || !failure.retryable;
        await this.options.store.failCreation(
          started.internal_investigation_id,
          failure.code,
          terminal,
          failure.retryable,
          this.now().toISOString(),
        );
        if (terminal) throw error;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
        await this.sleep(delay);
      }
    }

    throw new ResearchTwinTransportError('retry_loop_exhausted', false);
  }

  /**
   * Apply an already authenticated external snapshot. This is not a callback
   * route and performs no signature verification. A future callback boundary
   * must authenticate, authorize and replay-protect input before calling it.
   */
  async applyExternalUpdate(
    update: ResearchTwinExternalUpdate,
  ): Promise<{ record: ResearchTwinInvestigationRecord; duplicate: boolean }> {
    validateExternalUpdate(update);
    return this.options.store.applyExternalEvent({
      ...update,
      received_at: this.now().toISOString(),
    });
  }
}

function cloneRecord(record: ResearchTwinInvestigationRecord): ResearchTwinInvestigationRecord {
  return { ...record };
}

/**
 * Deterministic reference store for local tests only. It is not durable and is
 * deliberately not registered in the application or production database.
 */
export class InMemoryResearchTwinInvestigationStore implements ResearchTwinInvestigationStore {
  private readonly records = new Map<string, ResearchTwinInvestigationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly externalIds = new Map<string, string>();
  private readonly events = new Map<string, ResearchTwinLifecycleEvent>();
  private readonly eventIds = new Map<string, string[]>();

  private scope(tenantId: string, projectId: string): string {
    return `${tenantId} ${projectId}`;
  }

  async reserve(
    request: ResearchTwinInvestigationRequest,
    record: ResearchTwinInvestigationRecord,
  ): Promise<{ record: ResearchTwinInvestigationRecord; created: boolean }> {
    const key = `${this.scope(request.tenant_id, request.project_id)} ${request.idempotency_key}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      return { record: cloneRecord(this.records.get(existingId)!), created: false };
    }
    this.records.set(record.internal_investigation_id, cloneRecord(record));
    this.idempotency.set(key, record.internal_investigation_id);
    return { record: cloneRecord(record), created: true };
  }

  async startCreation(
    internalInvestigationId: string,
  ): Promise<{ record: ResearchTwinInvestigationRecord; started: boolean }> {
    const record = this.records.get(internalInvestigationId);
    if (!record) throw new ResearchTwinLifecycleError('unknown_investigation');
    if (record.creation_state !== 'pending' && record.creation_state !== 'awaiting_retry') {
      return { record: cloneRecord(record), started: false };
    }
    record.creation_state = 'creating';
    record.last_error_code = null;
    return { record: cloneRecord(record), started: true };
  }

  async recordCreationAttempt(internalInvestigationId: string): Promise<void> {
    const record = this.records.get(internalInvestigationId);
    if (record) record.creation_attempts++;
  }

  async completeCreation(
    internalInvestigationId: string,
    researchTwinInvestigationId: string,
    timestamp: string,
  ): Promise<ResearchTwinInvestigationRecord> {
    const record = this.records.get(internalInvestigationId);
    if (!record) throw new ResearchTwinLifecycleError('unknown_investigation');
    const externalKey = `${this.scope(record.tenant_id, record.project_id)} ${researchTwinInvestigationId}`;
    const existingInternalId = this.externalIds.get(externalKey);
    if (existingInternalId && existingInternalId !== internalInvestigationId) {
      throw new ResearchTwinTransportError('duplicate_external_investigation_id', false);
    }
    record.research_twin_investigation_id = researchTwinInvestigationId;
    record.creation_state = 'created';
    record.last_error_code = null;
    record.updated_at = timestamp;
    this.externalIds.set(externalKey, internalInvestigationId);
    return cloneRecord(record);
  }

  async failCreation(
    internalInvestigationId: string,
    code: string,
    terminal: boolean,
    retryable: boolean,
    timestamp: string,
  ): Promise<void> {
    const record = this.records.get(internalInvestigationId);
    if (!record) return;
    record.last_error_code = code;
    record.updated_at = timestamp;
    if (terminal) {
      record.creation_state = retryable ? 'awaiting_retry' : 'blocked_permanent_failure';
    }
  }

  async applyExternalEvent(
    event: ResearchTwinLifecycleEvent,
  ): Promise<{ record: ResearchTwinInvestigationRecord; duplicate: boolean }> {
    const scope = this.scope(event.tenant_id, event.project_id);
    const internalId = this.externalIds.get(`${scope} ${event.research_twin_investigation_id}`);
    if (!internalId) throw new ResearchTwinLifecycleError('unknown_investigation');
    const record = this.records.get(internalId)!;
    const eventKey = `${scope} ${event.research_twin_investigation_id} ${event.external_event_id}`;
    if (this.events.has(eventKey)) {
      return { record: cloneRecord(record), duplicate: true };
    }

    const storedEvent = { ...event };
    this.events.set(eventKey, storedEvent);
    const investigationKey = `${scope}\u0000${event.research_twin_investigation_id}`;
    const eventIds = this.eventIds.get(investigationKey) ?? [];
    eventIds.push(event.external_event_id);
    this.eventIds.set(investigationKey, eventIds);

    // Snapshots are stored in arrival order. No external ordering guarantee is
    // assumed until the owner-approved lifecycle contract defines one.
    record.assignment = event.assignment;
    record.lifecycle_status = event.lifecycle_status;
    record.updated_at = event.received_at;
    return { record: cloneRecord(record), duplicate: false };
  }

  async listExternalEvents(
    tenantId: string,
    projectId: string,
    researchTwinInvestigationId: string,
  ): Promise<ResearchTwinLifecycleEvent[]> {
    const scope = this.scope(tenantId, projectId);
    const internalId = this.externalIds.get(`${scope} ${researchTwinInvestigationId}`);
    if (!internalId) throw new ResearchTwinLifecycleError('unknown_investigation');
    const record = this.records.get(internalId)!;
    const investigationKey = `${scope} ${record.research_twin_investigation_id}`;
    const ids = this.eventIds.get(investigationKey) ?? [];
    return ids.map((id) => ({ ...this.events.get(`${investigationKey} ${id}`)! }));
  }
}
