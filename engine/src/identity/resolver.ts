import { IdentityContext, SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';

export class IdentityResolver {
  /**
   * Resolve a sender's phone number against the customers table.
   *
   * If the phone is already registered → return known identity with full unit context.
   * If the phone is NOT registered → auto-register as a new customer for this tenant
   * and return them as a known customer so connectors can serve them immediately.
   *
   * Per Spec §3: CST never stores the phone-to-person mapping permanently —
   * the customers table is a cached projection from vFarm's Customer Registry.
   * Auto-registered customers are tagged with `is_new_contact: true` in unit_context
   * so downstream systems can distinguish first-contact records from fully synced ones.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig
  ): Promise<IdentityContext> {
    // 1. Check in-memory store + Postgres
    let record = await DbClient.lookupCustomerByPhoneAsync(fromE164, systemConfig.tenant_id);

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

    // 2. Unknown sender — auto-register as a new contact for this tenant
    const customerRef = `auto_${systemConfig.tenant_id}_${fromE164.replace(/[^0-9]/g, '')}`;
    Logger.info(`Auto-registering new contact ${fromE164} as ${customerRef} for tenant ${systemConfig.tenant_id}`, {
      tenant_id: systemConfig.tenant_id,
      system_id: systemConfig.system_id,
    });

    await DbClient.seedCustomer({
      tenant_id:    systemConfig.tenant_id,
      phone_e164:   fromE164,
      customer_ref: customerRef,
    });

    return {
      customer_ref:      customerRef,
      tenant_id:         systemConfig.tenant_id,
      system_id:         systemConfig.system_id,
      is_known_customer: true,   // they are now registered
      unit_context: {
        is_new_contact: true,    // flag for downstream: not yet synced from vFarm
      },
    };
  }
}
