import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';

export interface FileIncidentParams {
  customerRef: string;
  conversationId: string;
  summary: string;
  subsystem?: string;
  engine?: string; // e.g. 'VFARM'
  workspaceKey?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  unitContext?: Record<string, unknown>;
}

export interface IncidentResult {
  /**
   * The REAL incident id returned by BHARAG, or `null` when creation failed.
   * CST NEVER fabricates an id: a made-up `inc_vfarm_*` value cannot be looked
   * up, escalated or closed by a human, so publishing one silently converts an
   * infrastructure failure into a customer-visible promise that nothing is
   * tracking.
   */
  incident_id: string | null;
  /** `open` on a real create; `unavailable` when BHARAG could not create one. */
  status: 'open' | 'pending' | 'resolved' | 'unavailable';
  created_at: string;
  /** True only when BHARAG confirmed the incident exists. */
  created: boolean;
  /** Present only on failure — never a substitute for an incident id. */
  error?: string;
}

/**
 * Map CST internal priority levels to BHARAG incident severity enum:
 * 'critical' | 'high' | 'warning' | 'info'
 */
function mapSeverity(priority?: string): 'critical' | 'high' | 'warning' | 'info' {
  switch (priority) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'warning';
    case 'low':
      return 'info';
    default:
      return 'high';
  }
}

/**
 * Map subsystem to a registered, upper-case alphanumeric code without underscores.
 * BHARAG enforces ^[A-Z][A-Z0-9]{1,15}$ registered against the target engine (e.g. VFARM).
 * Registered VFARM subsystems include: CLEANER, CLEANR, DEVICE, ENV, IRRIGATION, POLLINATION, POWER, PUMPS, WATER.
 */
function mapSubsystem(raw?: string): string {
  if (!raw) return 'DEVICE';
  const clean = raw.trim().toUpperCase();
  if (clean === 'CUSTOMER_TWIN') return 'DEVICE';
  if (/^[A-Z][A-Z0-9]{1,15}$/.test(clean)) return clean;
  return 'DEVICE';
}

export class BharagIncidentsConnector {
  /**
   * File incident in BHARAG incidents API (Spec §3, §4 & §6).
   * Authenticates via workspace-scoped key in `x-api-key` header.
   * CST stores ONLY the returned incident id on the conversation record.
   *
   * Integrity rule: if BHARAG does not return an incident id, this method
   * resolves with `created: false` and `incident_id: null`. It does not invent
   * an id and it does not persist one. Callers must surface the failure.
   */
  static async fileIncident(params: FileIncidentParams): Promise<IncidentResult> {
    const env = getEnv();
    const workspaceKey = params.workspaceKey || env.BHARAG_WORKSPACE_KEY;
    const apiUrl = env.BHARAG_API_URL;
    const severity = mapSeverity(params.priority);
    const subsystem = mapSubsystem(params.subsystem);

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: params.customerRef,
      role: 'customer_escalation',
      entry_point: 'api',
      tool_or_route: 'fileIncident',
      outcome: 'ok',
      reason: `Filing BHARAG incident ticket: ${params.summary}`,
      correlation_id: params.conversationId,
    });

    let incidentId: string | null = null;
    let failureReason: string | undefined;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // BHARAG POST /api/v1/incidents schema requires: source, severity, payload.
      // Subsystem is an uppercase alphanumeric registered code (e.g. DEVICE).
      const payload: Record<string, unknown> = {
        source: 'cst',
        severity,
        summary: params.summary ? params.summary.slice(0, 2000) : 'Customer escalation',
        subsystem,
        payload: {
          customer_ref: params.customerRef,
          conversation_id: params.conversationId,
          timestamp: new Date().toISOString(),
          ...(params.unitContext ? { unit_context: params.unitContext } : {}),
        },
      };

      const endpoint = `${apiUrl.replace(/\/$/, '')}/incidents`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': workspaceKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch((err: any) => {
        failureReason = err?.message || 'network error';
        return null;
      });

      clearTimeout(timeoutId);

      if (response && (response.ok || response.status === 201)) {
        const data = await response.json() as any;
        // BHARAG returns allocated canonical id in data.incident.entity_id or entity_id or incident_id
        const rawId =
          data?.incident?.entity_id ||
          data?.entity_id ||
          data?.incident_id ||
          data?.incident?.id ||
          data?.id ||
          null;
        incidentId =
          typeof rawId === 'string' && rawId.trim()
            ? rawId.trim()
            : null;
        if (!incidentId) {
          failureReason = `BHARAG responded ${response.status} without a recognized incident entity_id`;
        }
      } else {
        let errDetail = '';
        if (response) {
          try {
            const errJson = await response.json() as any;
            errDetail = errJson?.error?.message || errJson?.message || '';
          } catch {
            // body not json
          }
        }
        failureReason = response
          ? `BHARAG incidents API returned HTTP ${response.status}${errDetail ? `: ${errDetail}` : ''}`
          : 'BHARAG incidents API unreachable';
      }
    } catch (err: any) {
      failureReason = err?.message || String(err);
      Logger.warn(`BHARAG Incidents API error: ${failureReason}`);
    }

    const createdAt = new Date().toISOString();

    if (!incidentId) {
      // Fail honestly. Nothing is persisted: there is no id to record.
      const error = failureReason || 'unknown BHARAG incident failure';
      Logger.audit({
        timestamp: createdAt,
        tenant_id: null,
        actor: params.customerRef,
        role: 'customer_escalation',
        entry_point: 'api',
        tool_or_route: 'fileIncident',
        outcome: 'error',
        reason: `BHARAG incident creation FAILED — no incident id to store: ${error}`,
        correlation_id: params.conversationId,
      });
      Logger.infra({
        message: `BHARAG incident creation failed for conversation ${params.conversationId}`,
        commercial_impact:
          'Customer escalation was NOT ticketed. No incident exists to track or close, so the customer must be told escalation is unavailable and support must be contacted directly.',
        meta: {
          conversation_id: params.conversationId,
          customer_ref: params.customerRef,
          error,
        },
      });

      return {
        incident_id: null,
        status: 'unavailable',
        created_at: createdAt,
        created: false,
        error,
      };
    }

    const result: IncidentResult = {
      incident_id: incidentId,
      status: 'open',
      created_at: createdAt,
      created: true,
    };

    // Store ONLY the incident_id reference on the conversation record per Spec §3
    await DbClient.addIncidentToConversation(params.conversationId, incidentId);

    Logger.info(`Filed incident ${incidentId} in BHARAG incidents API for conversation ${params.conversationId}`);

    return result;
  }
}
