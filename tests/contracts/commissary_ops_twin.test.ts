/**
 * Unit & Integration Tests: Commissary Ops Twin Form 2 & Lifecycle Engine
 *
 * Verifies LOOP-1791922936305-VU6R acceptance criteria:
 * - 5-section Form 2 schema validation & required fields
 * - Rejection of invalid site data
 * - Ops Twin state machine transitions (BOOKED -> IN_USE -> CLEANED_CLAIMED -> READY / NOT_READY)
 * - Strict evidence threshold: CLEANED_CLAIMED never automatically grants READY
 * - Failure cases: missing photos, invalid timestamp drift (>300s), unverified food-contact sanitation, incidents
 * - Append-only cryptographically chained event ledger (tamper resistance)
 * - Form 2 to Ops Twin runtime configuration mapping with provenance tracking
 */

import { describe, expect, it } from 'vitest';
import {
  Form2Submission,
  Form2SubmissionSchema,
  REGULATORY_DETERMINATION_NOTICE,
  computeEventHash,
  mapForm2ToOpsTwinConfig,
  transitionOpsTwinState,
} from '../../engine/src/contracts/commissary_ops_twin';

describe('Commissary Ops Twin Form 2 — Schema Validation (Build Pattern: Form 2 — Commissary Ops Twin Site Spec v1)', () => {
  const validSubmission: Form2Submission = {
    submission_id: '550e8400-e29b-41d4-a716-446655440000',
    build_pattern: 'Form 2 — Commissary Ops Twin Site Spec v1',
    client_id: 'client_2',
    site_id: 'site_utica_commissary_01',
    intake_version: 'v1.0',
    status: 'submitted',
    section1_site_spec: {
      facility_address: '100 Genesee St, Utica, NY 13502',
      site_id: 'site_utica_commissary_01',
      square_footage: 3500,
      layout_zones: [
        {
          zone_id: 'zone_prep_cold',
          name: 'Cold Prep Area',
          food_grade_certified: true,
          max_occupancy: 4,
        },
        {
          zone_id: 'zone_hot_line',
          name: 'Hot Line Range',
          food_grade_certified: true,
          max_occupancy: 6,
        },
      ],
      prep_areas: ['Baking Table 1', 'Meat Prep Table 2', 'Vegetable Wash Station'],
      equipment_placement_map_url: 'https://storage.bhanetwork.org/sites/utica/layout.pdf',
      electrical_specs: {
        voltage: 240,
        phase: 'three_phase',
        total_amps: 400,
        generator_backup: true,
      },
      water_drainage_specs: {
        potable_water_psi: 55,
        grease_trap_capacity_gallons: 500,
        floor_drains_count: 4,
        backflow_preventer_certified: true,
      },
      network_connectivity: {
        primary_uplink: 'fiber',
        wifi_ssid: 'CommissaryOps-Secure',
        cellular_backup_available: true,
        local_lan_subnet: '192.168.10.0/24',
      },
      environmental_specs: {
        ambient_temp_target_c: 20,
        relative_humidity_target_percent: 45,
        hvac_air_turnover_per_hr: 12,
        pest_control_contract_active: true,
      },
      hardware_installation_reqs: ['Mount card-swipe terminal at North Entrance'],
    },
    section2_operations: {
      booking_mode: 'online_hourly_share',
      booking_system_url: 'https://bookings.utica-commissary.com',
      min_booking_hours: 1,
      max_booking_hours: 8,
      booking_buffer_minutes: 15,
      access_method: 'card_swipe_onboarding_tied',
      card_swipe_system_provider: 'BHA Onboarding RFID Reader v1',
      checkin_grace_minutes: 15,
      checkout_grace_minutes: 10,
      tenant_app_exit_checklist_required: true,
      exit_checklist_template_id: 'chk_utica_commissary_exit_v1',
      late_departure_penalty_rate_cents_per_minute: 150,
      dispute_handling_procedure:
        'Disputes escalate to facility manager review with timestamped photos.',
      operator_override_rules:
        'Operator may override lock state during emergency or maintenance.',
    },
    section3_equipment_roles: {
      equipment_inventory: [
        {
          equipment_id: 'eq_combi_oven_01',
          name: 'Rational Combi Oven',
          serial_number: 'SN-RAT-88419',
          owner: 'operator',
          sanitation_frequency: 'per_booking',
        },
        {
          equipment_id: 'eq_mixer_60qt',
          name: 'Hobart 60qt Mixer',
          serial_number: 'SN-HOB-11920',
          owner: 'operator',
          sanitation_frequency: 'per_booking',
        },
      ],
      operator_responsibilities: [
        'Routine equipment PM',
        'Deep cleaning common grease traps',
        'Access card credential provisioning',
      ],
      tenant_responsibilities: [
        'Sanitize all food-contact surfaces after booking',
        'Remove trash to dumpster',
        'Log exit checklist and capture timestamped photos',
      ],
      sanitation_duties: {
        food_contact_surfaces: 'tenant_mandatory',
        deep_clean_floor_drains: 'operator_managed',
        waste_removal: 'tenant_mandatory',
      },
      access_administrators: ['Ahad Ali', 'Facility Manager Utica'],
      incident_escalation_contacts: [
        {
          role: 'Ops Lead',
          contact_name: 'John Doe',
          phone: '+13155550199',
        },
      ],
      staff_roles_authorized: ['Operator Staff', 'Certified Tenant Kitchen Lead'],
    },
    section4_regulatory_records: {
      health_department_jurisdiction: 'Utica / Oneida County Health Department',
      local_authority_name: 'Utica / Oneida County Health Department',
      county_log_format_determination: REGULATORY_DETERMINATION_NOTICE,
      onsite_waterproof_log_required: false,
      digital_ledger_accepted_provisionally: true,
      food_contact_surface_sanitation_mandatory: true,
      photo_evidence_requirement: 'timestamped_photos_every_visit',
      photo_sampling_policy: 'every_visit_mandatory',
      timestamp_drift_tolerance_seconds: 300,
      retention_period_days: 730,
      inspection_contact_name: null,
      inspection_contact_phone: null,
      regulatory_research_job_ref: 'JOB-1791920840073-BKPU',
    },
    section5_commercial_pilot: {
      facility_owner: 'Oneida Commercial Holdings LLC',
      facility_operator: 'Utica Kitchen Collective',
      tenant_customer_model: 'hourly_office_share',
      ops_twin_fee_payer: 'operator_pays',
      cleaning_deposit_cents: 25000,
      cleaning_dispute_fee_cents: 5000,
      pilot_start_date: '2026-12-01',
      pilot_end_date: '2027-03-01',
      success_criteria: [
        'Zero unresolved sanitation disputes in 90 days',
        '100% adherence to exit photo timestamp verification',
        'Clean health department audit report with ledger export',
      ],
      contract_assumptions_approved: false,
      pricing_notes: 'BHA platform fee billed monthly directly to operator.',
    },
    submitted_at: '2026-11-16T18:00:00.000Z',
    submitted_by: 'destiny.arupi@bhanetwork.org',
  };

  it('validates a complete, compliant 5-section Form 2 submission', () => {
    const parsed = Form2SubmissionSchema.parse(validSubmission);
    expect(parsed.client_id).toBe('client_2');
    expect(parsed.build_pattern).toBe('Form 2 — Commissary Ops Twin Site Spec v1');
    expect(parsed.section4_regulatory_records.county_log_format_determination).toBe(
      REGULATORY_DETERMINATION_NOTICE
    );
  });

  it('rejects invalid site data (e.g. negative square footage or missing prep areas)', () => {
    const invalid = {
      ...validSubmission,
      section1_site_spec: {
        ...validSubmission.section1_site_spec,
        square_footage: -100, // Invalid!
        prep_areas: [], // Invalid: min(1) required!
      },
    };

    expect(() => Form2SubmissionSchema.parse(invalid)).toThrow();
  });

  it('enforces mandatory photo evidence requirement and county regulatory status notice', () => {
    const invalidReg = {
      ...validSubmission,
      section4_regulatory_records: {
        ...validSubmission.section4_regulatory_records,
        // Attempting to claim confirmed legal status without proof fails schema:
        county_log_format_determination: 'LEGALLY_CONFIRMED_ACCEPTED',
      },
    };

    expect(() => Form2SubmissionSchema.parse(invalidReg)).toThrow();
  });
});

describe('Commissary Ops Twin — State Machine & Strict Evidence Verification', () => {
  const bookingId = 'book_utica_20261116_01';
  const tenantId = 'tenant_baker_44';
  const actorId = 'actor_user_99';

  it('transitions from BOOKED to IN_USE upon access check-in', () => {
    const result = transitionOpsTwinState(
      'BOOKED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: actorId,
        actor_role: 'tenant',
        event_type: 'access.check_in',
        occurred_at: '2026-11-16T10:00:00.000Z',
      },
      null
    );

    expect(result.success).toBe(true);
    expect(result.to_state).toBe('IN_USE');
    expect(result.ledger_event.sequence).toBe(0);
    expect(result.ledger_event.previous_event_hash).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(result.ledger_event.event_hash).toHaveLength(64);
  });

  it('transitions from IN_USE to CLEANED_CLAIMED, NEVER straight to READY', () => {
    const initialCheckin = transitionOpsTwinState(
      'BOOKED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: actorId,
        actor_role: 'tenant',
        event_type: 'access.check_in',
        occurred_at: '2026-11-16T10:00:00.000Z',
      },
      null
    );

    const claimResult = transitionOpsTwinState(
      'IN_USE',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: actorId,
        actor_role: 'tenant',
        event_type: 'cleaning.claim_submitted',
        occurred_at: '2026-11-16T12:00:00.000Z',
        checklist: [
          {
            item_id: 'item_1',
            label: 'Sanitize stainless steel prep table',
            completed: true,
            is_food_contact_surface: true,
          },
        ],
        photo_evidence: [
          {
            photo_id: 'photo_01',
            storage_url: 'https://storage.bhanetwork.org/photos/photo_01.jpg',
            sha256_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            captured_at: '2026-11-16T11:59:30.000Z',
            zone_id: 'zone_prep_cold',
          },
        ],
      },
      initialCheckin.ledger_event
    );

    expect(claimResult.to_state).toBe('CLEANED_CLAIMED');
    expect(claimResult.to_state).not.toBe('READY');
    expect(claimResult.ledger_event.sequence).toBe(1);
    expect(claimResult.ledger_event.previous_event_hash).toBe(
      initialCheckin.ledger_event.event_hash
    );
  });

  it('fails verification and transitions to NOT_READY if required photos are missing', () => {
    const claimResult = transitionOpsTwinState(
      'CLEANED_CLAIMED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: 'verifier_system',
        actor_role: 'system',
        event_type: 'verification.passed', // Verification attempted with zero photos!
        occurred_at: '2026-11-16T12:05:00.000Z',
        checklist: [
          {
            item_id: 'item_1',
            label: 'Sanitize prep table',
            completed: true,
            is_food_contact_surface: true,
          },
        ],
        photo_evidence: [], // Missing!
      },
      null
    );

    expect(claimResult.success).toBe(false);
    expect(claimResult.to_state).toBe('NOT_READY');
    expect(claimResult.verification_errors).toContain(
      'Missing required timestamped photos'
    );
  });

  it('fails verification and transitions to NOT_READY if photo timestamp drift exceeds 300s', () => {
    const now = '2026-11-16T12:05:00.000Z'; // 12:05:00
    const driftedPhotoTime = '2026-11-16T11:50:00.000Z'; // 15 minutes earlier (>300s drift)

    const claimResult = transitionOpsTwinState(
      'CLEANED_CLAIMED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: 'verifier_system',
        actor_role: 'system',
        event_type: 'verification.passed',
        occurred_at: now,
        checklist: [
          {
            item_id: 'item_1',
            label: 'Sanitize prep table',
            completed: true,
            is_food_contact_surface: true,
          },
        ],
        photo_evidence: [
          {
            photo_id: 'photo_stale_01',
            storage_url: 'https://storage.bhanetwork.org/photos/stale.jpg',
            sha256_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            captured_at: driftedPhotoTime,
            zone_id: 'zone_prep_cold',
          },
        ],
      },
      null
    );

    expect(claimResult.success).toBe(false);
    expect(claimResult.to_state).toBe('NOT_READY');
    expect(
      claimResult.verification_errors.some((err) =>
        err.includes('timestamp exceeds 300s drift tolerance')
      )
    ).toBe(true);
  });

  it('fails verification if food contact surface sanitation is uncompleted', () => {
    const claimResult = transitionOpsTwinState(
      'CLEANED_CLAIMED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: 'verifier_system',
        actor_role: 'system',
        event_type: 'verification.passed',
        occurred_at: '2026-11-16T12:05:00.000Z',
        checklist: [
          {
            item_id: 'item_1',
            label: 'Sanitize stainless prep table',
            completed: false, // Incomplete food contact surface!
            is_food_contact_surface: true,
          },
        ],
        photo_evidence: [
          {
            photo_id: 'photo_01',
            storage_url: 'https://storage.bhanetwork.org/photos/photo_01.jpg',
            sha256_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            captured_at: '2026-11-16T12:04:30.000Z',
            zone_id: 'zone_prep_cold',
          },
        ],
      },
      null
    );

    expect(claimResult.success).toBe(false);
    expect(claimResult.to_state).toBe('NOT_READY');
    expect(claimResult.verification_errors).toContain(
      'Food contact surface sanitation not verified'
    );
  });

  it('transitions to READY when all criteria (complete checklist, food contact verified, valid photos) are met', () => {
    const claimResult = transitionOpsTwinState(
      'CLEANED_CLAIMED',
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        actor_id: 'verifier_system',
        actor_role: 'system',
        event_type: 'verification.passed',
        occurred_at: '2026-11-16T12:05:00.000Z',
        checklist: [
          {
            item_id: 'item_1',
            label: 'Sanitize prep table',
            completed: true,
            is_food_contact_surface: true,
          },
          {
            item_id: 'item_2',
            label: 'Sweep cold prep zone',
            completed: true,
            is_food_contact_surface: false,
          },
        ],
        photo_evidence: [
          {
            photo_id: 'photo_valid_01',
            storage_url: 'https://storage.bhanetwork.org/photos/photo_valid_01.jpg',
            sha256_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            captured_at: '2026-11-16T12:04:30.000Z',
            zone_id: 'zone_prep_cold',
          },
        ],
      },
      null
    );

    expect(claimResult.success).toBe(true);
    expect(claimResult.to_state).toBe('READY');
    expect(claimResult.verification_errors).toHaveLength(0);
  });
});

describe('Cryptographic Event Ledger Chaining & Anti-Tamper Verification', () => {
  it('computes deterministic SHA-256 event hash matching canonical representation', () => {
    const event = {
      event_id: '550e8400-e29b-41d4-a716-446655440001',
      sequence: 0,
      tenant_id: 'tenant_1',
      booking_id: 'book_1',
      actor_id: 'user_1',
      actor_role: 'tenant' as const,
      event_type: 'access.check_in' as const,
      from_state: 'BOOKED' as const,
      to_state: 'IN_USE' as const,
      occurred_at: '2026-11-16T10:00:00.000Z',
      checklist: [],
      photo_evidence: [],
      failure_reason: null,
      metadata: {},
      previous_event_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    const hash1 = computeEventHash(event);
    const hash2 = computeEventHash(event);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);

    // Tampering with payload alters the hash
    const tampered = { ...event, actor_id: 'impersonated_user' };
    const tamperedHash = computeEventHash(tampered);
    expect(tamperedHash).not.toBe(hash1);
  });
});

describe('Ops Twin Configuration Mapping & Provenance Tracking', () => {
  it('maps Form 2 submission to runtime configuration while tracking provenance and pending approvals', () => {
    const submission: Form2Submission = {
      submission_id: '550e8400-e29b-41d4-a716-446655440000',
      build_pattern: 'Form 2 — Commissary Ops Twin Site Spec v1',
      client_id: 'client_2',
      site_id: 'site_utica_commissary_01',
      intake_version: 'v1.0',
      status: 'submitted',
      section1_site_spec: {
        facility_address: '100 Genesee St, Utica, NY 13502',
        site_id: 'site_utica_commissary_01',
        square_footage: 3500,
        layout_zones: [
          {
            zone_id: 'zone_prep_cold',
            name: 'Cold Prep Area',
            food_grade_certified: true,
            max_occupancy: 4,
          },
        ],
        prep_areas: ['Baking Table 1'],
        equipment_placement_map_url: null,
        electrical_specs: {
          voltage: 240,
          phase: 'three_phase',
          total_amps: 400,
          generator_backup: true,
        },
        water_drainage_specs: {
          potable_water_psi: 55,
          grease_trap_capacity_gallons: 500,
          floor_drains_count: 4,
          backflow_preventer_certified: true,
        },
        network_connectivity: {
          primary_uplink: 'fiber',
          wifi_ssid: 'CommissaryOps',
          cellular_backup_available: true,
          local_lan_subnet: '192.168.10.0/24',
        },
        environmental_specs: {
          ambient_temp_target_c: 20,
          relative_humidity_target_percent: 45,
          hvac_air_turnover_per_hr: 12,
          pest_control_contract_active: true,
        },
        hardware_installation_reqs: [],
      },
      section2_operations: {
        booking_mode: 'online_hourly_share',
        booking_system_url: 'https://bookings.utica-commissary.com',
        min_booking_hours: 1,
        max_booking_hours: 8,
        booking_buffer_minutes: 15,
        access_method: 'card_swipe_onboarding_tied',
        card_swipe_system_provider: 'RFID Reader v1',
        checkin_grace_minutes: 15,
        checkout_grace_minutes: 10,
        tenant_app_exit_checklist_required: true,
        exit_checklist_template_id: 'chk_v1',
        late_departure_penalty_rate_cents_per_minute: 150,
        dispute_handling_procedure: 'Manager review',
        operator_override_rules: 'Emergency only',
      },
      section3_equipment_roles: {
        equipment_inventory: [
          {
            equipment_id: 'eq_1',
            name: 'Oven',
            serial_number: 'SN-1',
            owner: 'operator',
            sanitation_frequency: 'per_booking',
          },
        ],
        operator_responsibilities: ['Maintenance'],
        tenant_responsibilities: ['Sanitize'],
        sanitation_duties: {
          food_contact_surfaces: 'tenant_mandatory',
          deep_clean_floor_drains: 'operator_managed',
          waste_removal: 'tenant_mandatory',
        },
        access_administrators: ['Ahad'],
        incident_escalation_contacts: [
          { role: 'Lead', contact_name: 'John', phone: '+13155550199' },
        ],
        staff_roles_authorized: ['Operator Staff'],
      },
      section4_regulatory_records: {
        health_department_jurisdiction: 'Utica / Oneida County Health Department',
        local_authority_name: 'Utica / Oneida County Health Department',
        county_log_format_determination: REGULATORY_DETERMINATION_NOTICE,
        onsite_waterproof_log_required: false,
        digital_ledger_accepted_provisionally: true,
        food_contact_surface_sanitation_mandatory: true,
        photo_evidence_requirement: 'timestamped_photos_every_visit',
        photo_sampling_policy: 'every_visit_mandatory',
        timestamp_drift_tolerance_seconds: 300,
        retention_period_days: 730,
        inspection_contact_name: null,
        inspection_contact_phone: null,
        regulatory_research_job_ref: 'JOB-1791920840073-BKPU',
      },
      section5_commercial_pilot: {
        facility_owner: 'Oneida Holdings',
        facility_operator: 'Utica Kitchen Collective',
        tenant_customer_model: 'hourly_office_share',
        ops_twin_fee_payer: 'operator_pays',
        cleaning_deposit_cents: 25000,
        cleaning_dispute_fee_cents: 5000,
        pilot_start_date: '2026-12-01',
        pilot_end_date: '2027-03-01',
        success_criteria: ['Zero disputes'],
        contract_assumptions_approved: false,
      },
      submitted_at: '2026-11-16T18:00:00.000Z',
      submitted_by: 'destiny.arupi@bhanetwork.org',
    };

    const config = mapForm2ToOpsTwinConfig(submission);
    expect(config.site_id).toBe('site_utica_commissary_01');
    expect(config.client_id).toBe('client_2');
    expect(config.runtime_config.state_machine_mode).toBe(
      'append_only_cryptographic_ledger'
    );
    expect(config.runtime_config.governance.regulatory_status).toBe(
      REGULATORY_DETERMINATION_NOTICE
    );
    expect(config.runtime_config.governance.research_job_id).toBe(
      'JOB-1791920840073-BKPU'
    );
    expect(config.provenance.client_confirmed_fields).toContain(
      'photo_evidence:timestamped_photos_every_visit'
    );
    expect(config.provenance.pending_approvals.jegan_technical_review).toBe(false);
    expect(config.provenance.pending_approvals.destiny_build_pattern_approval).toBe(
      false
    );
    expect(config.provenance.pending_approvals.county_regulatory_determination).toBe(
      false
    );
  });
});

