import { randomUUID, createHash } from 'node:crypto';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
import { ResearchTwinClient } from './client.js';
import { isResearchTwinOperational } from './config.js';
import { lookupPatternByCategory, type ResearchPattern } from './patterns.js';
import type { ResearchTwinInvestigationRequest } from './lifecycle.js';

export interface FailureContext {
  tenant_id?: string;
  project_id?: string;
  correlation_id?: string;
  event_id?: string;
  webhook_receive_id?: string;
  category?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  details?: Record<string, unknown>;
  error?: string | Error;
}

export interface DispatchedInvestigationRecord {
  investigation_id: string;
  originating_incident_id: string;
  correlation_id: string;
  category: string;
  priority: string;
  dispatched_at: string;
  matched_pattern?: ResearchPattern;
}

export class ResearchTwinBridge {
  private static client: ResearchTwinClient | null = null;
  private static readonly DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private static recentDispatches = new Map<string, number>();
  private static dispatchedInvestigations: DispatchedInvestigationRecord[] = [];

  /**
   * Override or inject a specific client instance (e.g. for testing).
   */
  static setClient(client: ResearchTwinClient | null): void {
    this.client = client;
  }

  /**
   * Reset in-memory deduplication and dispatch log (for test isolation).
   */
  static reset(): void {
    this.recentDispatches.clear();
    this.dispatchedInvestigations = [];
    this.client = null;
  }

  /**
   * Retrieve records of investigations created during the current process life.
   */
  static getDispatchedInvestigations(): DispatchedInvestigationRecord[] {
    return [...this.dispatchedInvestigations];
  }

  /**
   * Determine if an operational failure warrants opening a Research Twin investigation.
   */
  static shouldQualifyFailure(category: string, error?: string, failureCount = 1): boolean {
    const cat = category.toLowerCase();

    // Critical database persistence failures always qualify immediately
    if (cat.includes('persistence') || cat.includes('database')) {
      return true;
    }

    // Unhandled processing crashes qualify immediately
    if (cat.includes('processing') || cat.includes('internal_error')) {
      return true;
    }

    // Telemetry staleness (>24h) qualifies
    if (cat.includes('sensor_telemetry_stale') || cat.includes('device_connectivity_loss')) {
      return true;
    }

    // Slack delivery failures qualify if persistent (>1 attempt)
    if (cat.includes('slack')) {
      return failureCount >= 2;
    }

    // Webhook auth failures qualify only if repeated (burst/attack or bad secret rotation)
    if (cat.includes('auth')) {
      return failureCount >= 3;
    }

    // Callback state anomalies qualify if repeated
    if (cat.includes('twilio') || cat.includes('callback')) {
      return failureCount >= 2;
    }

    return false;
  }

  /**
   * Hook called by FailureDetector when a failure is detected.
   * Runs asynchronously without blocking the caller.
   */
  static reportFailureAsync(category: string, error?: string, context: FailureContext = {}, failureCount = 1): void {
    // Check if failure qualifies
    if (!this.shouldQualifyFailure(category, error, failureCount)) {
      return;
    }

    // Check if Research Twin is enabled/operational
    if (!isResearchTwinOperational() && !this.client) {
      Logger.info(`ResearchTwinBridge: failure ${category} not dispatched (Research Twin is blocked/unavailable)`);
      return;
    }

    // Bounded fire-and-forget
    void this.dispatchInvestigation(category, error, context).catch((dispatchErr) => {
      Logger.warn(`ResearchTwinBridge: investigation dispatch failed: ${dispatchErr?.message}`);
    });
  }

  /**
   * Create and dispatch a Research Twin investigation for a qualified failure.
   */
  static async dispatchInvestigation(
    category: string,
    error?: string,
    context: FailureContext = {}
  ): Promise<DispatchedInvestigationRecord | null> {
    const tenantId = context.tenant_id || 'tenant-vfarm-01';
    const projectId = context.project_id || 'proj-vfarm-main';
    const correlationId = context.correlation_id || `corr_${randomUUID()}`;
    const errorStr = String(error || (context.error instanceof Error ? context.error.message : context.error) || 'unknown error');

    // Compute deduplication key
    const dedupFingerprint = createHash('sha256')
      .update(`${category}:${correlationId}:${errorStr}`)
      .digest('hex')
      .substring(0, 16);
    const dedupKey = `rt_dedup_${category}_${dedupFingerprint}`;

    const now = Date.now();
    const lastDispatch = this.recentDispatches.get(dedupKey);
    if (lastDispatch && now - lastDispatch < this.DEDUP_WINDOW_MS) {
      Logger.info(`ResearchTwinBridge: duplicate investigation suppressed for ${dedupKey}`);
      return null;
    }
    this.recentDispatches.set(dedupKey, now);

    // Look up matching canonical resolution pattern
    const matchedPattern = lookupPatternByCategory(category, errorStr);

    // Map priority
    const priority =
      category.includes('persistence') || category.includes('processing')
        ? 'critical'
        : context.severity || 'high';

    const incidentId = `inc_cst_${randomUUID()}`;
    const occurredAt = new Date().toISOString();

    const request: ResearchTwinInvestigationRequest = {
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: correlationId,
      source_system: 'bha-cst',
      originating_incident_id: incidentId,
      occurred_at: occurredAt,
      event_type: `investigation.${category.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      priority,
      idempotency_key: `rt_idemp_${incidentId}`,
    };

    const client = this.client || new ResearchTwinClient();

    let investigationId = `rt_inv_mock_${randomUUID()}`;
    try {
      const result = await client.createInvestigation(request);
      if (result && result.investigation_id) {
        investigationId = result.investigation_id;
      }
    } catch (apiErr: any) {
      Logger.warn(`ResearchTwinBridge: upstream investigation dispatch failed (${apiErr?.message}); logging incident locally`);
      investigationId = `rt_inv_local_${randomUUID()}`;
    }

    const record: DispatchedInvestigationRecord = {
      investigation_id: investigationId,
      originating_incident_id: incidentId,
      correlation_id: correlationId,
      category,
      priority,
      dispatched_at: occurredAt,
      matched_pattern: matchedPattern,
    };
    this.dispatchedInvestigations.push(record);

    // Persist to dashboard_publish_outcomes for durable audit trail
    try {
      await DbClient.recordDashboardPublishOutcome({
        event_id: incidentId,
        event_type: 'cst.research_twin.investigation',
        specversion: 'cst.event.v1',
        correlation_id: correlationId,
        tenant_id: tenantId,
        project_id: projectId,
        status: 'internal_only',
        attempts: 1,
        payload: {
          request,
          investigation_id: investigationId,
          diagnostic_details: {
            error: errorStr,
            context_details: context.details,
            event_id: context.event_id,
            webhook_receive_id: context.webhook_receive_id,
          },
          matched_pattern: matchedPattern
            ? {
                pattern_id: matchedPattern.pattern_id,
                title: matchedPattern.title,
                resolution: matchedPattern.resolution_summary,
                runbook: matchedPattern.runbook_reference,
              }
            : null,
        },
      });
    } catch (dbErr: any) {
      Logger.warn(`ResearchTwinBridge: failed to persist investigation outcome: ${dbErr?.message}`);
    }

    Logger.info(
      `ResearchTwinBridge: opened investigation ${investigationId} for [${category}] (correlation: ${correlationId})`
    );

    return record;
  }
}
