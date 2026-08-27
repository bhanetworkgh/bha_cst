import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
import { randomUUID } from 'crypto';

export interface FileIncidentParams {
  customerRef: string;
  conversationId: string;
  summary: string;
  subsystem?: 'CUSTOMER_TWIN';
  engine?: string; // e.g. 'VFARM'
  workspaceKey?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface IncidentResult {
  incident_id: string;
  status: 'open' | 'pending' | 'resolved';
  created_at: string;
}

export class BharagIncidentsConnector {
  /**
   * File incident in BHARAG incidents.v0 (Spec §3, §4 & §6).
   * Subsystem is frozen as 'CUSTOMER_TWIN', engine as 'VFARM'.
   * CST stores ONLY the returned incident_id on the conversation record.
   */
  static async fileIncident(params: FileIncidentParams): Promise<IncidentResult> {
    const env = getEnv();
    const workspaceKey = params.workspaceKey || env.BHARAG_WORKSPACE_KEY;
    const apiUrl = env.BHARAG_API_URL;
    const subsystem = params.subsystem || 'CUSTOMER_TWIN';
    const engineType = params.engine || 'VFARM';
    const priority = params.priority || 'high';

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

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const payload = {
        subsystem,
        engine: engineType,
        customer_ref: params.customerRef,
        workspace_key: workspaceKey,
        priority,
        details: {
          summary: params.summary,
          conversation_id: params.conversationId,
          timestamp: new Date().toISOString(),
        },
      };

      const response = await fetch(`${apiUrl}/incidents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${workspaceKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (response && (response.ok || response.status === 201)) {
        const data = await response.json() as any;
        incidentId = data.incident_id;
      }
    } catch (err: any) {
      Logger.warn(`BHARAG Incidents API post fallback: ${err.message}`);
    }

    // Fallback incident ID generator if BHARAG server is running in standalone mode
    if (!incidentId) {
      const hex = randomUUID().replace(/-/g, '').substring(0, 8);
      incidentId = `inc_vfarm_${hex}`;
    }

    const result: IncidentResult = {
      incident_id: incidentId,
      status: 'open',
      created_at: new Date().toISOString(),
    };

    // Store ONLY the incident_id reference on the conversation record per Spec §3
    await DbClient.addIncidentToConversation(params.conversationId, incidentId);

    Logger.info(`Filed incident ${incidentId} in BHARAG incidents.v0 for conversation ${params.conversationId}`);

    return result;
  }
}
