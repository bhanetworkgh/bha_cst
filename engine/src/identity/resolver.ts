import { IdentityContext, SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';

export class IdentityResolver {
  /**
   * Resolve a sender's phone number against the customers table in DbClient.
   *
   * Per Spec §3: CST never stores the phone-to-person mapping permanently —
   * the customers table is a cached projection from vFarm's Customer Registry.
   * The source-of-truth always remains vFarm.
   *
   * If the phone is not in the customers table → unknown sender path.
   * DO NOT GUESS identity.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig
  ): Promise<IdentityContext> {
    const record = DbClient.lookupCustomerByPhone(fromE164, systemConfig.tenant_id);

    if (record) {
      Logger.info(`Resolved identity for ${fromE164}`, {
        tenant_id:    systemConfig.tenant_id,
        customer_ref: record.customer_ref,
      });
      return {
        customer_ref:      record.customer_ref,
        tenant_id:         systemConfig.tenant_id,
        system_id:         systemConfig.system_id,
        is_known_customer: true,
        unit_context: {
          ...(record.unit_id ? { unit_id: record.unit_id } : {}),
          ...(record.farm_id ? { farm_id: record.farm_id } : {}),
        },
      };
    }

    Logger.warn(`Unknown sender ${fromE164} — not in customers table for tenant ${systemConfig.tenant_id}`, {
      tenant_id: systemConfig.tenant_id,
      system_id: systemConfig.system_id,
    });

    // Unknown sender: opaque reference, no guessed identity
    return {
      customer_ref:      `opaque_unresolved_${fromE164.replace(/[^0-9]/g, '')}`,
      tenant_id:         systemConfig.tenant_id,
      system_id:         systemConfig.system_id,
      is_known_customer: false,
    };
  }
}
