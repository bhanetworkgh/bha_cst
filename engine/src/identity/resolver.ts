import { IdentityContext, SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
// Import from the leaf-level permissions module (no upstream deps) to avoid
// the circular init chain: db/client → registry → vfarm/index → resolver → db/client.
// Re-export so existing callers of identity/resolver.ts continue to work.
import { getPermissionsForRole } from './permissions.js';
export { getPermissionsForRole } from './permissions.js';

/**
 * @deprecated Thin bridge to the active tenant-adapter identity path.
 *
 * The authoritative runtime chain is:
 *
 *   Twilio To   -> service_number_binding -> tenant/project/capability
 *   Twilio From -> vFarm tenant adapter   -> person / role / farm_ids
 *
 * New code should call `CoreRegistry.resolveSpeaker({ tenantId, projectId,
 * phoneE164 })` directly (that is what the SMS and Web ingress lanes already do).
 * This class remains because the voice lane still funnels through it; it simply
 * delegates to the adapter whenever a `projectId` is supplied.
 *
 * **No project scope means no identity.** Called without a `projectId` there is
 * no `service_number_binding`, so there is no tenancy chain and this class
 * refuses rather than guessing. The unscoped `customers`-table branch is
 * opt-in (`allowUnscopedLookup`) and is strictly non-authorizing: it can name a
 * `customer_ref` for audit correlation, but it never grants a role, permissions,
 * or farm scope. Farm-authoritative scope only ever comes from the vFarm
 * adapter's live farm-grant lookup.
 */
export class IdentityResolver {
  /**
   * Resolve a sender's phone number against the system's customer registry.
   *
   * Architecture Tenancy Chain:
   * Receiving Number -> service_number_binding -> tenant/project -> speaker -> role -> permissions
   *
   * Resolution path (G9/G14 — single source of truth):
   *   When the caller supplies `projectId`, identity is resolved through
   *   `CoreRegistry.resolveSpeaker`, i.e. the SAME active tenant-adapter path
   *   used by SMS and Web. That path re-verifies against vFarm on every resolve
   *   and returns the authoritative `farm_ids`. This is the preferred path and
   *   the only one that authorizes anything.
   *
   *   Without a `projectId` the caller cannot supply a tenancy chain, so this
   *   method refuses. The `customers`-table lookup is reachable only via the
   *   explicit `allowUnscopedLookup` opt-in and cannot authorize; see the class
   *   docblock.
   *
   * - Known user: resolved server-side, returning role & permissions.
   * - Unknown user: if phone is NOT pre-onboarded, do NOT guess identity or auto-register.
   *   Returns is_known_customer: false, role: 'unknown', permissions: [].
   * - Strict E.164 phone matching is required. Partial matches are treated as unknown.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig,
    options: { projectId?: string; allowUnscopedLookup?: boolean } = {},
  ): Promise<IdentityContext> {
    const orgId = systemConfig.organization_id || systemConfig.tenant_id;
    // The workspace is the project scope. `ws-vfarm-main` is gone as a runtime
    // default: a hardcoded legacy workspace id silently mis-stamped transcripts
    // and audit rows for every tenant.
    const defaultWsId = systemConfig.workspace_id || options.projectId || orgId;

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

    // ── No project scope: DENY by default ───────────────────────────────────
    // Without a project there is no `service_number_binding`, so there is no
    // tenancy chain and nothing that can authorize this caller. The legacy
    // `customers` table cannot be scoped to a project and its `farm_id` /
    // `farm_ids` columns are not vFarm-authoritative, so it is never allowed to
    // mint a role, permissions, or farm scope.
    //
    // `allowUnscopedLookup` is an explicit, non-default opt-in used only for
    // diagnostics and legacy-data audits. Even then the result is
    // correlation-only: it can name the caller for audit joins, but it grants no
    // permissions and carries no farm scope.
    const deniedIdentity = (reason: string, customerRef?: string): IdentityContext => ({
      customer_ref:      customerRef || `opaque_unresolved_${cleanPhone.replace(/[^0-9]/g, '')}`,
      organization_id:   orgId,
      tenant_id:         orgId,
      system_id:         systemConfig.system_id,
      workspace_id:      defaultWsId,
      is_known_customer: false,
      role:              'unknown',
      permissions:       [],
    });

    if (!options.allowUnscopedLookup) {
      Logger.warn(
        `IdentityResolver: REFUSING identity for ${cleanPhone} in org ${orgId} — no projectId supplied, ` +
          `so no service_number_binding could resolve a tenancy chain. Bind the receiving number to a ` +
          `project, or resolve through CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164 }).`
      );
      return deniedIdentity('no_project_scope');
    }

    Logger.warn(
      `IdentityResolver: unscoped customers-table lookup for ${cleanPhone} (explicit opt-in, ` +
        `non-authorizing: grants no permissions and no farm scope)`
    );
    const record = await DbClient.lookupCustomerByPhoneAsync(cleanPhone, orgId);

    if (record) {
      Logger.info(
        `Correlated ${cleanPhone} to customer_ref ${record.customer_ref} in org ${orgId} via unscoped lookup ` +
          `(non-authorizing; role/farm scope intentionally dropped)`,
        {
          organization_id: orgId,
          tenant_id:       orgId,
          customer_ref:    record.customer_ref,
        }
      );

      return deniedIdentity('unscoped_lookup_non_authorizing', record.customer_ref);
    }

    // 2. Unknown sender — do NOT guess identity, do NOT auto-register in DB.
    // Return unresolved identity context so router can serve safe onboarding reply.
    Logger.info(`Unregistered sender ${cleanPhone} for org ${orgId}`, {
      organization_id: orgId,
      tenant_id:       orgId,
      system_id:       systemConfig.system_id,
      workspace_id:    defaultWsId,
    });

    return deniedIdentity('unscoped_lookup_miss');
  }
}
