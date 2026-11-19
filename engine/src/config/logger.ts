import { SlackNotifier } from '../notifications/slack.js';

export type LogOutcome = 'ok' | 'refused' | 'error';
export type EntryPoint = 'webhook' | 'admin_panel' | 'api';

export interface SecurityLedgerEvent {
  id?: string;
  timestamp: string;
  tenant_id: string | null;
  actor: string;
  role: string;
  entry_point: EntryPoint;
  tool_or_route: string;
  outcome: LogOutcome;
  reason?: string;
  correlation_id?: string;
  /** Explicit commercial or reliability impact statement for security/infra audit trail. */
  commercial_impact?: string;
  details?: Record<string, unknown>;
}

export interface InfraEvent {
  message: string;
  /** Required: explicit statement of commercial or reliability impact. */
  commercial_impact: string;
  meta?: Record<string, unknown>;
}

export class Logger {
  private static auditRingBuffer: SecurityLedgerEvent[] = [];

  static getRecentAuditEvents(limit = 50): SecurityLedgerEvent[] {
    return [...this.auditRingBuffer].slice(-limit).reverse();
  }

  private static formatLog(level: string, message: string, meta?: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    });
  }

  static info(message: string, meta?: Record<string, unknown>): void {
    console.log(this.formatLog('INFO', message, meta));
  }

  static warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(this.formatLog('WARN', message, meta));
  }

  static error(message: string, meta?: Record<string, unknown>, notify = true): void {
    console.error(this.formatLog('ERROR', message, meta));
    // Callers with a class-specific alert route must not also send a generic alert.
    if (!notify) return;
    // Asynchronously dispatch Slack error alert
    SlackNotifier.sendErrorAlert({
      title: 'System Error',
      message,
      severity: 'ERROR',
      tenant_id: (meta?.tenant_id as string) || null,
      correlation_id: (meta?.correlation_id as string) || undefined,
      meta,
    }).catch(() => {});
  }

  /**
   * Emit a structured infrastructure/reliability event log.
   * `commercial_impact` is mandatory — every infra event must state its business consequence.
   * Use for: telemetry unavailability, outbound send failures, rate-limit breaches, API outages.
   */
  static infra(event: InfraEvent): void {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      type: 'INFRA_EVENT',
      message: event.message,
      commercial_impact: event.commercial_impact,
      ...event.meta,
    }));

    // If infrastructure event represents a permanent delivery failure or critical reliability issue, notify Slack
    if (event.commercial_impact && /failure|outage|permanently|exhausted/i.test(event.message + event.commercial_impact)) {
      SlackNotifier.sendErrorAlert({
        title: 'Infrastructure Reliability Event',
        message: `${event.message} — Impact: ${event.commercial_impact}`,
        severity: 'CRITICAL',
        tenant_id: (event.meta?.tenant_id as string) || null,
        correlation_id: (event.meta?.correlation_id as string) || undefined,
        meta: event.meta,
      }).catch(() => {});
    }
  }



  static audit(event: SecurityLedgerEvent): void {
    const timestamp = event.timestamp || new Date().toISOString();
    this.auditRingBuffer.push({ ...event, timestamp });
    if (this.auditRingBuffer.length > 200) {
      this.auditRingBuffer.shift();
    }

    // Persist to the database security_ledger table (fire-and-forget)
    void (async () => {
      try {
        const { DbClient } = await import('../db/client.js');
        await DbClient.recordSecurityLedgerEvent({ ...event, timestamp });
      } catch {
        // DB persistence failure is non-fatal; the in-memory ring buffer
        // and console log already captured the event.
      }
    })();

    const payload = {
      timestamp,
      type: 'SECURITY_LEDGER',
      tenant_id: event.tenant_id,
      actor: event.actor,
      role: event.role,
      entry_point: event.entry_point,
      tool_or_route: event.tool_or_route,
      outcome: event.outcome,
      reason: event.reason,
      correlation_id: event.correlation_id,
      ...(event.commercial_impact ? { commercial_impact: event.commercial_impact } : {}),
      ...event.details,
    };

    if (event.outcome === 'refused') {
      console.warn(JSON.stringify({ ...payload, level: 'WARN', tripwire: true }));
    } else if (event.outcome === 'error') {
      console.error(JSON.stringify({ ...payload, level: 'ERROR' }));
      SlackNotifier.sendErrorAlert({
        title: `Security Ledger Error: ${event.tool_or_route}`,
        message: event.reason || 'Security ledger error encountered',
        severity: 'ERROR',
        tenant_id: event.tenant_id,
        correlation_id: event.correlation_id,
        meta: { actor: event.actor, role: event.role, commercial_impact: event.commercial_impact, ...event.details },
      }).catch(() => {});
    } else {
      console.log(JSON.stringify({ ...payload, level: 'INFO' }));
    }
  }
}

