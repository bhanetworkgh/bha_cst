/**
 * Commissary Ops Twin — Contract, Schema, and Lifecycle Engine
 *
 * Implements the reusable Build Pattern: Form 2 — Commissary Ops Twin Site Spec v1
 * Loop: LOOP-1791922936305-VU6R
 * Related Card: CARD-1791918264578-MTUW (Audits 2015, 2016, 2017)
 * Research Job: JOB-1791920840073-BKPU (Utica/Oneida County Log Format)
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ============================================================================
// 1. Regulatory Status Notice
// ============================================================================

export const REGULATORY_DETERMINATION_NOTICE =
  'VERIFICATION REQUIRED — NOT AN OFFICIALLY CONFIRMED REGULATORY DETERMINATION' as const;

// ============================================================================
// 2. State Machine Constants & Enums
// ============================================================================

export const OPS_TWIN_STATES = [
  'BOOKED',
  'IN_USE',
  'CLEANED_CLAIMED',
  'READY',
  'NOT_READY',
] as const;

export type OpsTwinState = (typeof OPS_TWIN_STATES)[number];

export const OpsTwinStateSchema = z.enum(OPS_TWIN_STATES);

export const OPS_TWIN_EVENT_TYPES = [
  'booking.created',
  'access.check_in',
  'access.check_out',
  'cleaning.claim_submitted',
  'verification.passed',
  'verification.failed',
  'override.operator_intervention',
  'incident.reported',
  'dispute.raised',
] as const;

export type OpsTwinEventType = (typeof OPS_TWIN_EVENT_TYPES)[number];

export const OpsTwinEventTypeSchema = z.enum(OPS_TWIN_EVENT_TYPES);

// ============================================================================
// 3. Section 1 Schema — Kitchen Layout & Site Requirements
// ============================================================================

export const Section1SiteRequirementsSchema = z.object({
  facility_address: z.string().min(1, 'facility_address is required'),
  site_id: z.string().min(1, 'site_id is required'),
  square_footage: z.number().positive('square_footage must be positive'),
  layout_zones: z
    .array(
      z.object({
        zone_id: z.string().min(1),
        name: z.string().min(1),
        food_grade_certified: z.boolean(),
        max_occupancy: z.number().int().positive(),
      })
    )
    .min(1, 'At least one layout zone is required'),
  prep_areas: z.array(z.string().min(1)).min(1, 'At least one prep area is required'),
  equipment_placement_map_url: z.string().url().nullable().optional(),
  electrical_specs: z.object({
    voltage: z.number().positive(),
    phase: z.enum(['single_phase', 'three_phase']),
    total_amps: z.number().positive(),
    generator_backup: z.boolean(),
  }),
  water_drainage_specs: z.object({
    potable_water_psi: z.number().positive(),
    grease_trap_capacity_gallons: z.number().positive(),
    floor_drains_count: z.number().int().nonnegative(),
    backflow_preventer_certified: z.boolean(),
  }),
  network_connectivity: z.object({
    primary_uplink: z.enum(['fiber', 'cable', 'dsl', 'fixed_wireless']),
    wifi_ssid: z.string().min(1),
    cellular_backup_available: z.boolean(),
    local_lan_subnet: z.string().min(1),
  }),
  environmental_specs: z.object({
    ambient_temp_target_c: z.number(),
    relative_humidity_target_percent: z.number().min(0).max(100),
    hvac_air_turnover_per_hr: z.number().positive(),
    pest_control_contract_active: z.boolean(),
  }),
  hardware_installation_reqs: z.array(z.string()).default([]),
});

export type Section1SiteRequirements = z.infer<typeof Section1SiteRequirementsSchema>;

// ============================================================================
// 4. Section 2 Schema — Booking, Handover & Cleaning Operations
// ============================================================================

export const Section2OperationsSchema = z.object({
  booking_mode: z.literal('online_hourly_share'),
  booking_system_url: z.string().url(),
  min_booking_hours: z.number().positive(),
  max_booking_hours: z.number().positive(),
  booking_buffer_minutes: z.number().int().nonnegative(),
  access_method: z.literal('card_swipe_onboarding_tied'),
  card_swipe_system_provider: z.string().min(1),
  checkin_grace_minutes: z.number().int().nonnegative(),
  checkout_grace_minutes: z.number().int().nonnegative(),
  tenant_app_exit_checklist_required: z.literal(true),
  exit_checklist_template_id: z.string().min(1),
  late_departure_penalty_rate_cents_per_minute: z.number().int().nonnegative(),
  dispute_handling_procedure: z.string().min(1),
  operator_override_rules: z.string().min(1),
});

export type Section2Operations = z.infer<typeof Section2OperationsSchema>;

// ============================================================================
// 5. Section 3 Schema — Equipment, Staffing & Responsibilities
// ============================================================================

export const Section3EquipmentResponsibilitiesSchema = z.object({
  equipment_inventory: z
    .array(
      z.object({
        equipment_id: z.string().min(1),
        name: z.string().min(1),
        serial_number: z.string().min(1),
        owner: z.enum(['operator', 'tenant']),
        sanitation_frequency: z.enum(['per_booking', 'daily', 'weekly']),
      })
    )
    .min(1, 'At least one equipment record required'),
  operator_responsibilities: z.array(z.string().min(1)).min(1),
  tenant_responsibilities: z.array(z.string().min(1)).min(1),
  sanitation_duties: z.object({
    food_contact_surfaces: z.literal('tenant_mandatory'),
    deep_clean_floor_drains: z.literal('operator_managed'),
    waste_removal: z.literal('tenant_mandatory'),
  }),
  access_administrators: z.array(z.string().min(1)).min(1),
  incident_escalation_contacts: z
    .array(
      z.object({
        role: z.string().min(1),
        contact_name: z.string().min(1),
        phone: z.string().min(1),
      })
    )
    .min(1),
  staff_roles_authorized: z.array(z.string().min(1)).min(1),
});

export type Section3EquipmentResponsibilities = z.infer<
  typeof Section3EquipmentResponsibilitiesSchema
>;

// ============================================================================
// 6. Section 4 Schema — Health Inspection & Operational Records
// ============================================================================

export const Section4RegulatoryRecordsSchema = z.object({
  health_department_jurisdiction: z.string().min(1),
  local_authority_name: z.literal('Utica / Oneida County Health Department'),
  county_log_format_determination: z.literal(REGULATORY_DETERMINATION_NOTICE),
  onsite_waterproof_log_required: z.boolean(),
  digital_ledger_accepted_provisionally: z.boolean(),
  food_contact_surface_sanitation_mandatory: z.literal(true),
  photo_evidence_requirement: z.literal('timestamped_photos_every_visit'),
  photo_sampling_policy: z.literal('every_visit_mandatory'),
  timestamp_drift_tolerance_seconds: z.number().int().positive().default(300),
  retention_period_days: z.number().int().positive().default(730),
  inspection_contact_name: z.string().nullable().optional(),
  inspection_contact_phone: z.string().nullable().optional(),
  regulatory_research_job_ref: z.literal('JOB-1791920840073-BKPU'),
});

export type Section4RegulatoryRecords = z.infer<typeof Section4RegulatoryRecordsSchema>;

// ============================================================================
// 7. Section 5 Schema — Ownership, Commercial Model & Pilot Goals
// ============================================================================

export const Section5CommercialPilotSchema = z.object({
  facility_owner: z.string().min(1),
  facility_operator: z.string().min(1),
  tenant_customer_model: z.literal('hourly_office_share'),
  ops_twin_fee_payer: z.enum(['operator_pays', 'bha_bundled', 'hybrid_cost_share']),
  cleaning_deposit_cents: z.number().int().nonnegative(),
  cleaning_dispute_fee_cents: z.number().int().nonnegative(),
  pilot_start_date: z.string().min(1),
  pilot_end_date: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  contract_assumptions_approved: z.boolean(),
  pricing_notes: z.string().optional(),
});

export type Section5CommercialPilot = z.infer<typeof Section5CommercialPilotSchema>;

// ============================================================================
// 8. Full Form 2 Submission Schema
// ============================================================================

export const FORM2_STATUSES = [
  'draft',
  'submitted',
  'incomplete',
  'under_review',
  'approved',
] as const;

export type Form2Status = (typeof FORM2_STATUSES)[number];

export const Form2StatusSchema = z.enum(FORM2_STATUSES);

export const Form2SubmissionSchema = z.object({
  submission_id: z.string().uuid(),
  build_pattern: z.literal('Form 2 — Commissary Ops Twin Site Spec v1'),
  client_id: z.string().min(1),
  site_id: z.string().min(1),
  intake_version: z.literal('v1.0'),
  status: Form2StatusSchema,
  section1_site_spec: Section1SiteRequirementsSchema,
  section2_operations: Section2OperationsSchema,
  section3_equipment_roles: Section3EquipmentResponsibilitiesSchema,
  section4_regulatory_records: Section4RegulatoryRecordsSchema,
  section5_commercial_pilot: Section5CommercialPilotSchema,
  submitted_at: z.string().refine((val) => Number.isFinite(Date.parse(val)), {
    message: 'submitted_at must be valid ISO timestamp',
  }),
  submitted_by: z.string().min(1),
});

export type Form2Submission = z.infer<typeof Form2SubmissionSchema>;

// ============================================================================
// 9. Append-Only Cryptographically Chained Ledger Event Schema
// ============================================================================

export const PhotoEvidenceItemSchema = z.object({
  photo_id: z.string().min(1),
  storage_url: z.string().url(),
  sha256_hash: z.string().length(64),
  captured_at: z.string().refine((val) => Number.isFinite(Date.parse(val)), {
    message: 'captured_at must be ISO timestamp',
  }),
  zone_id: z.string().min(1),
});

export type PhotoEvidenceItem = z.infer<typeof PhotoEvidenceItemSchema>;

export const ChecklistItemSchema = z.object({
  item_id: z.string().min(1),
  label: z.string().min(1),
  completed: z.boolean(),
  is_food_contact_surface: z.boolean(),
});

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const OpsTwinLedgerEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  tenant_id: z.string().min(1),
  booking_id: z.string().min(1),
  actor_id: z.string().min(1),
  actor_role: z.enum(['tenant', 'operator', 'system', 'health_inspector']),
  event_type: OpsTwinEventTypeSchema,
  from_state: OpsTwinStateSchema,
  to_state: OpsTwinStateSchema,
  occurred_at: z.string().refine((val) => Number.isFinite(Date.parse(val)), {
    message: 'occurred_at must be valid ISO timestamp',
  }),
  checklist: z.array(ChecklistItemSchema).default([]),
  photo_evidence: z.array(PhotoEvidenceItemSchema).default([]),
  failure_reason: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  previous_event_hash: z.string().min(1),
  event_hash: z.string().length(64),
});

export type OpsTwinLedgerEvent = z.infer<typeof OpsTwinLedgerEventSchema>;

// ============================================================================
// 10. Ledger Hashing & Chaining Helper
// ============================================================================

export function computeEventHash(
  event: Omit<OpsTwinLedgerEvent, 'event_hash'>
): string {
  const canonicalPayload = JSON.stringify({
    event_id: event.event_id,
    sequence: event.sequence,
    tenant_id: event.tenant_id,
    booking_id: event.booking_id,
    actor_id: event.actor_id,
    actor_role: event.actor_role,
    event_type: event.event_type,
    from_state: event.from_state,
    to_state: event.to_state,
    occurred_at: event.occurred_at,
    checklist: event.checklist,
    photo_evidence: event.photo_evidence,
    failure_reason: event.failure_reason,
    metadata: event.metadata,
    previous_event_hash: event.previous_event_hash,
  });

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

export function createChainedLedgerEvent(
  params: Omit<OpsTwinLedgerEvent, 'event_hash'>
): OpsTwinLedgerEvent {
  const event_hash = computeEventHash(params);
  return {
    ...params,
    event_hash,
  };
}

// ============================================================================
// 11. State Machine Engine & Verification Guardrails
// ============================================================================

export interface TransitionRequest {
  booking_id: string;
  tenant_id: string;
  actor_id: string;
  actor_role: 'tenant' | 'operator' | 'system' | 'health_inspector';
  event_type: OpsTwinEventType;
  occurred_at: string;
  checklist?: ChecklistItem[];
  photo_evidence?: PhotoEvidenceItem[];
  failure_reason?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  success: boolean;
  to_state: OpsTwinState;
  ledger_event: OpsTwinLedgerEvent;
  verification_errors: string[];
}

/**
 * Validates transition and produces the next cryptographically chained event.
 * Core rule: CLEANED_CLAIMED DOES NOT AUTOMATICALLY GRANT READY.
 */
export function transitionOpsTwinState(
  currentState: OpsTwinState,
  request: TransitionRequest,
  lastEvent: OpsTwinLedgerEvent | null
): TransitionResult {
  const verificationErrors: string[] = [];
  let targetState: OpsTwinState = currentState;

  const sequence = lastEvent ? lastEvent.sequence + 1 : 0;
  const previous_event_hash = lastEvent
    ? lastEvent.event_hash
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const checklist = request.checklist ?? [];
  const photos = request.photo_evidence ?? [];

  switch (currentState) {
    case 'BOOKED': {
      if (request.event_type === 'access.check_in') {
        targetState = 'IN_USE';
      } else if (request.event_type === 'override.operator_intervention') {
        targetState = (request.metadata?.target_state as OpsTwinState) || 'NOT_READY';
      } else {
        verificationErrors.push(
          `Invalid event ${request.event_type} for state BOOKED`
        );
        targetState = 'NOT_READY';
      }
      break;
    }

    case 'IN_USE': {
      if (request.event_type === 'cleaning.claim_submitted') {
        // Tenant claims cleaned. Moves to CLEANED_CLAIMED, NEVER straight to READY.
        targetState = 'CLEANED_CLAIMED';

        if (checklist.length === 0) {
          verificationErrors.push('Exit checklist is empty or missing');
        }
        if (photos.length === 0) {
          verificationErrors.push(
            'Photo evidence is mandatory ("timestamped photo evidence of everything")'
          );
        }
      } else if (request.event_type === 'incident.reported') {
        targetState = 'NOT_READY';
        verificationErrors.push(
          request.failure_reason || 'Incident reported during active session'
        );
      } else {
        verificationErrors.push(
          `Invalid event ${request.event_type} for state IN_USE`
        );
        targetState = 'NOT_READY';
      }
      break;
    }

    case 'CLEANED_CLAIMED': {
      if (request.event_type === 'verification.passed') {
        // Strict verification gate for READY
        const incompleteItems = checklist.filter((i) => !i.completed);
        if (incompleteItems.length > 0) {
          verificationErrors.push(
            `Incomplete checklist items: ${incompleteItems.map((i) => i.label).join(', ')}`
          );
        }

        const unverifiedFoodContact = checklist.filter(
          (i) => i.is_food_contact_surface && !i.completed
        );
        if (unverifiedFoodContact.length > 0) {
          verificationErrors.push(
            'Food contact surface sanitation not verified'
          );
        }

        if (photos.length === 0) {
          verificationErrors.push('Missing required timestamped photos');
        }

        // Validate photo timestamps
        const now = Date.parse(request.occurred_at);
        for (const p of photos) {
          const photoTime = Date.parse(p.captured_at);
          if (!Number.isFinite(photoTime)) {
            verificationErrors.push(`Photo ${p.photo_id} has invalid timestamp`);
          } else if (Math.abs(now - photoTime) > 300 * 1000) {
            verificationErrors.push(
              `Photo ${p.photo_id} timestamp exceeds 300s drift tolerance`
            );
          }
        }

        if (verificationErrors.length === 0) {
          targetState = 'READY';
        } else {
          targetState = 'NOT_READY';
        }
      } else if (
        request.event_type === 'verification.failed' ||
        request.event_type === 'dispute.raised'
      ) {
        targetState = 'NOT_READY';
        if (request.failure_reason) {
          verificationErrors.push(request.failure_reason);
        }
      } else {
        verificationErrors.push(
          `Invalid event ${request.event_type} for state CLEANED_CLAIMED`
        );
        targetState = 'NOT_READY';
      }
      break;
    }

    case 'READY': {
      if (request.event_type === 'booking.created') {
        targetState = 'BOOKED';
      } else if (request.event_type === 'incident.reported') {
        targetState = 'NOT_READY';
        verificationErrors.push('Incident reported on ready station');
      } else {
        verificationErrors.push(
          `Invalid event ${request.event_type} for state READY`
        );
        targetState = 'NOT_READY';
      }
      break;
    }

    case 'NOT_READY': {
      if (request.event_type === 'override.operator_intervention') {
        targetState = (request.metadata?.target_state as OpsTwinState) || 'READY';
      } else if (request.event_type === 'verification.passed') {
        targetState = 'READY';
      } else {
        verificationErrors.push(
          'Station is in NOT_READY state; requires operator intervention or verification passing'
        );
        targetState = 'NOT_READY';
      }
      break;
    }

    default:
      targetState = 'NOT_READY';
  }

  const success = verificationErrors.length === 0 && targetState !== 'NOT_READY';

  const ledger_event = createChainedLedgerEvent({
    event_id: crypto.randomUUID(),
    sequence,
    tenant_id: request.tenant_id,
    booking_id: request.booking_id,
    actor_id: request.actor_id,
    actor_role: request.actor_role,
    event_type: request.event_type,
    from_state: currentState,
    to_state: targetState,
    occurred_at: request.occurred_at,
    checklist,
    photo_evidence: photos,
    failure_reason: verificationErrors.length > 0 ? verificationErrors.join('; ') : null,
    metadata: request.metadata ?? {},
    previous_event_hash,
  });

  return {
    success,
    to_state: targetState,
    ledger_event,
    verification_errors: verificationErrors,
  };
}

// ============================================================================
// 12. Ops Twin Configuration Mapping Function
// ============================================================================

export interface ConfiguredOpsTwin {
  site_id: string;
  client_id: string;
  submission_id: string;
  intake_version: string;
  runtime_config: {
    state_machine_mode: 'append_only_cryptographic_ledger';
    allowed_states: typeof OPS_TWIN_STATES;
    booking_rules: {
      mode: 'online_hourly_share';
      min_hours: number;
      max_hours: number;
      buffer_minutes: number;
    };
    access_rules: {
      method: 'card_swipe_onboarding_tied';
      provider: string;
    };
    cleaning_and_verification: {
      checklist_template_id: string;
      photo_requirement: 'timestamped_photos_every_visit';
      max_timestamp_drift_seconds: number;
      food_contact_verification_mandatory: true;
    };
    zones: Array<{
      zone_id: string;
      name: string;
      food_grade: boolean;
      occupancy: number;
    }>;
    equipment_ids: string[];
    governance: {
      regulatory_status: string;
      research_job_id: string;
      jurisdiction: string;
      retention_days: number;
    };
    commercial: {
      billing_model: string;
      fee_payer: string;
      cleaning_deposit_cents: number;
      dispute_fee_cents: number;
    };
  };
  provenance: {
    client_confirmed_fields: string[];
    independently_verified_fields: string[];
    pending_approvals: {
      jegan_technical_review: boolean;
      destiny_build_pattern_approval: boolean;
      county_regulatory_determination: boolean;
    };
  };
}

export function mapForm2ToOpsTwinConfig(submission: Form2Submission): ConfiguredOpsTwin {
  // Validate schema first
  const validated = Form2SubmissionSchema.parse(submission);

  return {
    site_id: validated.site_id,
    client_id: validated.client_id,
    submission_id: validated.submission_id,
    intake_version: validated.intake_version,
    runtime_config: {
      state_machine_mode: 'append_only_cryptographic_ledger',
      allowed_states: OPS_TWIN_STATES,
      booking_rules: {
        mode: 'online_hourly_share',
        min_hours: validated.section2_operations.min_booking_hours,
        max_hours: validated.section2_operations.max_booking_hours,
        buffer_minutes: validated.section2_operations.booking_buffer_minutes,
      },
      access_rules: {
        method: 'card_swipe_onboarding_tied',
        provider: validated.section2_operations.card_swipe_system_provider,
      },
      cleaning_and_verification: {
        checklist_template_id: validated.section2_operations.exit_checklist_template_id,
        photo_requirement: validated.section4_regulatory_records.photo_evidence_requirement,
        max_timestamp_drift_seconds:
          validated.section4_regulatory_records.timestamp_drift_tolerance_seconds,
        food_contact_verification_mandatory: true,
      },
      zones: validated.section1_site_spec.layout_zones.map((z) => ({
        zone_id: z.zone_id,
        name: z.name,
        food_grade: z.food_grade_certified,
        occupancy: z.max_occupancy,
      })),
      equipment_ids: validated.section3_equipment_roles.equipment_inventory.map(
        (e) => e.equipment_id
      ),
      governance: {
        regulatory_status: validated.section4_regulatory_records.county_log_format_determination,
        research_job_id: validated.section4_regulatory_records.regulatory_research_job_ref,
        jurisdiction: validated.section4_regulatory_records.local_authority_name,
        retention_days: validated.section4_regulatory_records.retention_period_days,
      },
      commercial: {
        billing_model: validated.section5_commercial_pilot.tenant_customer_model,
        fee_payer: validated.section5_commercial_pilot.ops_twin_fee_payer,
        cleaning_deposit_cents: validated.section5_commercial_pilot.cleaning_deposit_cents,
        dispute_fee_cents: validated.section5_commercial_pilot.cleaning_dispute_fee_cents,
      },
    },
    provenance: {
      client_confirmed_fields: [
        'booking_mode:online_hourly_share',
        'access_method:card_swipe_onboarding_tied',
        'cleaning:tenant_app_exit_checklist_required',
        'photo_evidence:timestamped_photos_every_visit',
        'health_dept:client_aligning_with_county',
      ],
      independently_verified_fields: [
        'schema_compatibility_with_vfarm_site_survey',
        'cryptographic_sha256_event_chaining',
        'fail_closed_ready_evaluation',
      ],
      pending_approvals: {
        jegan_technical_review: false, // DW-1793342080834-M7GY
        destiny_build_pattern_approval: false, // DW-1793290384075-UDZG
        county_regulatory_determination: false, // JOB-1791920840073-BKPU
      },
    },
  };
}

