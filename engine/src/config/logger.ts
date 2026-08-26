export type LogOutcome = 'ok' | 'refused' | 'error';
export type EntryPoint = 'webhook' | 'admin_panel' | 'api';

export interface SecurityLedgerEvent {
  timestamp: string;
  tenant_id: string | null;
  actor: string;
  role: string;
  entry_point: EntryPoint;
  tool_or_route: string;
  outcome: LogOutcome;
  reason?: string;
  correlation_id?: string;
  details?: Record<string, unknown>;
}

export class Logger {
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

  static error(message: string, meta?: Record<string, unknown>): void {
    console.error(this.formatLog('ERROR', message, meta));
  }

  static audit(event: SecurityLedgerEvent): void {
    const payload = {
      timestamp: event.timestamp || new Date().toISOString(),
      type: 'SECURITY_LEDGER',
      tenant_id: event.tenant_id,
      actor: event.actor,
      role: event.role,
      entry_point: event.entry_point,
      tool_or_route: event.tool_or_route,
      outcome: event.outcome,
      reason: event.reason,
      correlation_id: event.correlation_id,
      ...event.details,
    };

    if (event.outcome === 'refused') {
      console.warn(JSON.stringify({ ...payload, level: 'WARN', tripwire: true }));
    } else if (event.outcome === 'error') {
      console.error(JSON.stringify({ ...payload, level: 'ERROR' }));
    } else {
      console.log(JSON.stringify({ ...payload, level: 'INFO' }));
    }
  }
}
