import { Logger } from '../config/logger.js';

export interface CutOverConfiguration {
  /** Explicit start timestamp in ISO-8601 UTC */
  start_timestamp: string;
  timezone: string;
  /** Whether the cut-over has been formally approved by Jason */
  is_approved: boolean;
  approved_by?: string;
  approval_ref?: string;
  /** Last-known event ID prior to forward cut-over */
  boundary_event_id?: string;
  notes?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: 'approved_forward_event' | 'historical_event_pre_cutover' | 'boundary_event_duplicate' | 'cutover_not_activated';
  timestamp: string;
  event_id: string;
}

export class CutOverManager {
  private static config: CutOverConfiguration = {
    // Configurable default baseline; CST_CUTOVER_APPROVED is approval metadata per Jason's ruling, not a runtime ingestion gate.
    start_timestamp: process.env.CST_CUTOVER_START_TIMESTAMP || '2026-11-03T00:00:00.000Z',
    timezone: 'UTC',
    is_approved: process.env.CST_CUTOVER_APPROVED === 'true',
    approved_by: process.env.CST_CUTOVER_APPROVED_BY,
    boundary_event_id: process.env.CST_CUTOVER_BOUNDARY_EVENT_ID || 'evt_boundary_pre_cutover_000',
    notes: 'Forward-only cutover metadata. Ingestion processes all forward events >= start_timestamp without runtime blocking.',
  };

  private static ignoredHistoricalEvents: Array<{ event_id: string; timestamp: string; reason: string }> = [];

  static getConfig(): CutOverConfiguration {
    return { ...this.config };
  }

  static configure(updates: Partial<CutOverConfiguration>): void {
    this.config = {
      ...this.config,
      ...updates,
    };
    Logger.info(`CutOverManager: configuration updated`, {
      start_timestamp: this.config.start_timestamp,
      is_approved: this.config.is_approved,
      approved_by: this.config.approved_by,
      boundary_event_id: this.config.boundary_event_id,
    });
  }

  static reset(): void {
    this.config = {
      start_timestamp: process.env.CST_CUTOVER_START_TIMESTAMP || '2026-11-03T00:00:00.000Z',
      timezone: 'UTC',
      is_approved: process.env.CST_CUTOVER_APPROVED === 'true',
      approved_by: process.env.CST_CUTOVER_APPROVED_BY,
      boundary_event_id: process.env.CST_CUTOVER_BOUNDARY_EVENT_ID || 'evt_boundary_pre_cutover_000',
      notes: 'Forward-only cutover metadata. Ingestion processes all forward events >= start_timestamp without runtime blocking.',
    };
    this.ignoredHistoricalEvents = [];
  }

  static getIgnoredEvents(): Array<{ event_id: string; timestamp: string; reason: string }> {
    return [...this.ignoredHistoricalEvents];
  }

  /**
   * Determine whether an incoming event is eligible for forward processing.
   */
  static isEventEligible(eventTime: string | number, eventId: string): EligibilityResult {
    const eventIso = typeof eventTime === 'number'
      ? new Date(eventTime * 1000).toISOString()
      : new Date(eventTime).toISOString();

    const eventEpoch = new Date(eventIso).getTime();
    const cutOverEpoch = new Date(this.config.start_timestamp).getTime();

    // 1. Check boundary event duplicate
    if (this.config.boundary_event_id && eventId === this.config.boundary_event_id) {
      const record = {
        event_id: eventId,
        timestamp: eventIso,
        reason: 'boundary_event_duplicate' as const,
      };
      this.ignoredHistoricalEvents.push(record);
      Logger.warn(`CutOverManager: boundary event ${eventId} ignored to prevent historical replay`, record);
      return {
        eligible: false,
        reason: 'boundary_event_duplicate',
        timestamp: eventIso,
        event_id: eventId,
      };
    }

    // 2. Check timestamp boundary
    if (eventEpoch < cutOverEpoch) {
      const record = {
        event_id: eventId,
        timestamp: eventIso,
        reason: 'historical_event_pre_cutover' as const,
      };
      this.ignoredHistoricalEvents.push(record);
      Logger.info(`CutOverManager: pre-cutover event ${eventId} (${eventIso}) ignored; prior to ${this.config.start_timestamp}`, record);
      return {
        eligible: false,
        reason: 'historical_event_pre_cutover',
        timestamp: eventIso,
        event_id: eventId,
      };
    }

    // 3. Event timestamp is >= start_timestamp (at or after the cut-over boundary).
    // CST_CUTOVER_APPROVED is approval metadata only (never a runtime ingestion gate),
    // so forward events are eligible regardless of whether is_approved is true or false.
    return {
      eligible: true,
      reason: 'approved_forward_event',
      timestamp: eventIso,
      event_id: eventId,
    };
  }
}

