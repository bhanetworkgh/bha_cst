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
   * Resolution path (G9/G14 — single source of truth):
   *   When the caller supplies `projectId`, identity is resolved through
   *   `CoreRegistry.resolveSpeaker`, i.e. the SAME active tenant-adapter path
   *   used by SMS and Web. That path re-verifies against vFarm on every resolve
   *   and returns the authoritative `farm_ids`. This is the preferred path.
   *
   *   The `customers`-table lookup below is retained ONLY as a fallback for
   *   callers that cannot supply a project (it cannot be scoped to one, and it
   *   reads the legacy single `farm_id` column rather than `farm_ids`). Prefer
   *   passing `projectId`; see voice_lane.ts, which resolves it from the
   *   service-number binding.
   *
   * - Known user: resolved server-side, returning role & permissions.
   * - Unknown user: if phone is NOT pre-onboarded, do NOT guess identity or auto-register.
   *   Returns is_known_customer: false, role: 'unknown', permissions: [].
   * - Strict E.164 phone matching is required. Partial matches are treated as unknown.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig,
    options: { projectId?: string } = {},
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

    // Preferred path: the active tenant-adapter resolver shared with SMS/Web.
    if (options.projectId) {
      // Dynamic import avoids the module-load cycle documented in permissions.ts.
      const { CoreRegistry } = await import('../core/registry.js');
      const speaker = await CoreRegistry.resolveSpeaker({
        tenantId: orgId,
        projectId: options.projectId,
        phoneE164: cleanPhone,
      });

      const speakerRole = (['owner', 'manager', 'tech'].includes(speaker.role as string)
        ? speaker.role
        : 'unknown') as 'owner' | 'manager' | 'tech' | 'unknown';

      if (speaker.is_known) {
        Logger.info(`Resolved identity for ${cleanPhone} in org ${orgId} via tenant adapter (project=${options.projectId}, role=${speakerRole})`, {
          organization_id: orgId,
          tenant_id:       orgId,
          project_id:      options.projectId,
          customer_ref:    speaker.customer_ref,
          role:            speakerRole,
        });

        return {
          customer_ref:      speaker.customer_ref,
          organization_id:   orgId,
          tenant_id:         orgId,
          project_id:        options.projectId,
          system_id:         systemConfig.system_id,
          workspace_id:      defaultWsId,
          is_known_customer: true,
          role:              speakerRole,
          permissions:       getPermissionsForRole(speakerRole),
          unit_context: {
            person_id: speaker.person_id,
            // Full vFarm-verified scope. The legacy fallback below can only offer
            // the single `farm_id` column, which is why it is not preferred.
            farm_ids: speaker.farm_ids,
            farm_id: speaker.farm_ids?.[0],
            role: speakerRole,
          },
        };
      }

      // Adapter resolved the caller as unknown — fail closed, never auto-register.
      const safeRef = `opaque_unresolved_${cleanPhone.replace(/[^0-9]/g, '')}`;
      Logger.info(`Unregistered sender ${cleanPhone} for org ${orgId} (tenant adapter, project=${options.projectId})`, {
        organization_id: orgId,
        tenant_id:       orgId,
        project_id:      options.projectId,
        system_id:       systemConfig.system_id,
        workspace_id:    defaultWsId,
      });

      return {
        customer_ref:      safeRef,
        organization_id:   orgId,
        tenant_id:         orgId,
        project_id:        options.projectId,
        system_id:         systemConfig.system_id,
        workspace_id:      defaultWsId,
        is_known_customer: false,
        role:              'unknown',
        permissions:       [],
      };
    }

    // Legacy fallback: no project scope available. Not preferred — see above.
    Logger.warn(`IdentityResolver: no projectId supplied for ${cleanPhone}; falling back to unscoped customers-table lookup`);
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
        project_id:        record.project_id,
        system_id:         systemConfig.system_id,
        workspace_id:      userWsId,
        is_known_customer: true,
        role:              userRole,
        permissions,
        unit_context: {
          ...(record.unit_id ? { unit_id: record.unit_id } : {}),
          ...(record.farm_id ? { farm_id: record.farm_id } : {}),
          // Prefer the full array even on the fallback path when the row has it.
          ...(record.farm_ids && record.farm_ids.length ? { farm_ids: record.farm_ids } : {}),
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
