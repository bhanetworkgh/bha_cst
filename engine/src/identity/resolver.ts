import { IdentityContext, SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
// Import from the leaf-level permissions module (no upstream deps) to avoid
// the circular init chain: db/client → registry → vfarm/index → resolver → db/client.
// Re-export so existing callers of identity/resolver.ts continue to work.
import { getPermissionsForRole } from './permissions.js';
export { getPermissionsForRole } from './permissions.js';

export class IdentityResolver {
  /**
   * Resolve a sender's phone number against the system's customer registry.
   *
   * Architecture Tenancy Chain:
   * Receiving Number -> System -> Organization -> Workspace -> Customer -> Role -> Permissions
   *
   * - Known user: resolved server-side from customer registry within Organization scope, returning role & permissions.
   * - Unknown user: if phone is NOT pre-onboarded, do NOT guess identity or auto-register.
   *   Returns is_known_customer: false, role: 'unknown', permissions: [].
   * - Strict E.164 phone matching is required. Partial matches are treated as unknown.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig
  ): Promise<IdentityContext> {
    const orgId = systemConfig.organization_id || systemConfig.tenant_id;
    const defaultWsId = systemConfig.workspace_id || 'ws-vfarm-main';

    if (!fromE164) {
      return {
        customer_ref:      'opaque_unresolved_user',
        organization_id:   orgId,
        tenant_id:         orgId,
        system_id:         systemConfig.system_id,
        workspace_id:      defaultWsId,
        is_known_customer: false,
        role:              'unknown',
        permissions:       [],
      };
    }

    const cleanPhone = fromE164.trim();
    // 1. Check in-memory store + Postgres for exact E.164 phone match within Organization scope
    const record = await DbClient.lookupCustomerByPhoneAsync(cleanPhone, orgId);

    if (record) {
      const userRole = record.role || 'manager';
      const permissions = getPermissionsForRole(userRole);
      const userWsId = record.workspace_id || defaultWsId;

      Logger.info(`Resolved identity for ${cleanPhone} in org ${orgId} (workspace=${userWsId}, role=${userRole})`, {
        organization_id: orgId,
        tenant_id:       orgId,
        workspace_id:    userWsId,
        customer_ref:    record.customer_ref,
        role:            userRole,
      });

      return {
        customer_ref:      record.customer_ref,
        organization_id:   orgId,
        tenant_id:         orgId,
        system_id:         systemConfig.system_id,
        workspace_id:      userWsId,
        is_known_customer: true,
        role:              userRole,
        permissions,
        unit_context: {
          ...(record.unit_id ? { unit_id: record.unit_id } : {}),
          ...(record.farm_id ? { farm_id: record.farm_id } : {}),
          role: userRole,
        },
      };
    }

    // 2. Unknown sender — do NOT guess identity, do NOT auto-register in DB.
    // Return unresolved identity context so router can serve safe onboarding reply.
    const safeRef = `opaque_unresolved_${cleanPhone.replace(/[^0-9]/g, '')}`;
    Logger.info(`Unregistered sender ${cleanPhone} for org ${orgId}`, {
      organization_id: orgId,
      tenant_id:       orgId,
      system_id:       systemConfig.system_id,
      workspace_id:    defaultWsId,
    });

    return {
      customer_ref:      safeRef,
      organization_id:   orgId,
      tenant_id:         orgId,
      system_id:         systemConfig.system_id,
      workspace_id:      defaultWsId,
      is_known_customer: false,
      role:              'unknown',
      permissions:       [],
    };
  }
}
