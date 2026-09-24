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
 */
export function assertSpeakerFarmAccess(
  speaker: SpeakerIdentity,
  farmId: string,
  dynamicAllowedFarms?: string[],
): void {
  const target = (farmId || '').trim();
  if (!target) {
    throw new VfarmAuthorizationError('farm_id is required');
  }
  if (!speaker?.is_known && (speaker?.role as string) !== 'admin' && (speaker?.role as string) !== 'superadmin') {
    throw new VfarmAuthorizationError('Speaker is not authorized for farm access');
  }
  const granted = speaker.farm_ids ?? [];
  const dynamicAllowed = dynamicAllowedFarms ?? [];
  const isSuperOrAdmin = (speaker.role as string) === 'admin' || (speaker.role as string) === 'superadmin';
  if (!isSuperOrAdmin && !granted.includes(target) && !dynamicAllowed.includes(target)) {
    throw new VfarmAuthorizationError(
      `Speaker is not authorized for farm ${target}; granted farms: [${granted.join(', ')}]`,
    );
  }
}
