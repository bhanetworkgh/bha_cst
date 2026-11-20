import type { SpeakerIdentity } from '../../core/types.js';

/** Thrown when a caller requests a farm outside their resolved speaker scope (local 403). */
export class VfarmAuthorizationError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'VfarmAuthorizationError';
  }
}

/**
 * Enforce CST speaker farm scope before any outbound vFarm API call.
 * X-Farm-Key is service credentials only — never treated as speaker authorization.
 *
 * Requirements:
 * 1. Accepts strictly SpeakerIdentity (no legacy speaker_id fallback).
 * 2. An authenticated speaker can access ONLY farms explicitly in their authoritative `farm_ids`.
 * 3. Tenant-discovered farms do NOT independently authorize access (dynamicAllowedFarms removed).
 * 4. Missing or empty person_id fails closed (403).
 * 5. Unknown caller (is_known: false) fails closed (403), even if an admin role is claimed.
 * 6. Admin and superadmin follow an authenticated policy: bypasses farm grant scope iff authenticated (is_known: true).
 */
export function assertSpeakerFarmAccess(
  speaker: SpeakerIdentity,
  farmId: string,
): void {
  const target = (farmId || '').trim();
  if (!target) {
    throw new VfarmAuthorizationError('farm_id is required');
  }

  const personId = typeof speaker?.person_id === 'string' ? speaker.person_id.trim() : '';
  if (!personId) {
    throw new VfarmAuthorizationError('Missing acting-user ID on protected farm request');
  }

  // Reject any conflicting legacy identifier if present on the object
  if ((speaker as { speaker_id?: unknown })?.speaker_id !== undefined) {
    const rawSpeakerId = (speaker as { speaker_id?: unknown }).speaker_id;
    if (typeof rawSpeakerId === 'string' && rawSpeakerId.trim() !== personId) {
      throw new VfarmAuthorizationError('Conflicting speaker identity identifiers: person_id and speaker_id mismatch');
    }
  }

  // Must be authenticated to access protected farm telemetry or invoke admin scope
  if (!speaker?.is_known) {
    throw new VfarmAuthorizationError('Speaker is not authorized for farm access: unauthenticated identity');
  }

  const role = speaker?.role as string | undefined;
  const isSuperOrAdmin = role === 'admin' || role === 'superadmin';

  const granted = speaker.farm_ids ?? [];
  if (!isSuperOrAdmin && !granted.includes(target)) {
    throw new VfarmAuthorizationError(
      `Speaker is not authorized for farm ${target}; granted farms: [${granted.join(', ')}]`,
    );
  }
}
