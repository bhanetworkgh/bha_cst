import type { UserRole } from '../core/types.js';

/**
 * Pure role-to-permissions mapping.
 *
 * This module is intentionally dependency-free so that it can be imported
 * by both the identity resolver (which loads DbClient) and the vFarm adapter
 * (which is loaded by the registry, which is loaded by DbClient) without
 * creating a circular ESM initialisation chain.
 *
 * Import chain that was previously cyclic:
 *   db/client → registry → vfarm/index → identity/resolver → db/client  ✗
 *
 * After this extraction:
 *   db/client → registry → vfarm/index → identity/permissions  ✓  (no further up-chain imports)
 *   identity/resolver → identity/permissions  ✓  (unchanged behaviour)
 */
export function getPermissionsForRole(role: UserRole | 'unknown'): string[] {
  switch (role) {
    case 'owner':
      return ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate', 'write:settings'];
    case 'manager':
      return ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate'];
    case 'tech':
      return ['read:telemetry', 'read:knowledge', 'read:media', 'write:escalate'];
    default:
      return [];
  }
}
