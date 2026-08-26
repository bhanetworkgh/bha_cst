import { IdentityContext, SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';

// Seeded known customer mappings for vFarm system #1 (for tests & demonstration)
const knownCustomersMap: Record<string, { customer_ref: string; unit_context: Record<string, unknown> }> = {
  '+15551234567': {
    customer_ref: 'cust_vfarm_001_john_doe',
    unit_context: { unit_id: 'unit_bay_04', farm_id: 'farm_austin_main' },
  },
  '+15558887777': {
    customer_ref: 'cust_vfarm_002_alice_smith',
    unit_context: { unit_id: 'unit_bay_12', farm_id: 'farm_austin_main' },
  },
};

export class IdentityResolver {
  /**
   * Resolve phone number against vFarm customer registry.
   * If sender phone number is not recognized, return unknown sender identity context.
   * DO NOT GUESS identity.
   */
  static async resolveSenderIdentity(
    fromE164: string,
    systemConfig: SystemConfig
  ): Promise<IdentityContext> {
    const known = knownCustomersMap[fromE164];

    if (known) {
      Logger.info(`Resolved identity for ${fromE164}`, {
        tenant_id: systemConfig.tenant_id,
        customer_ref: known.customer_ref,
      });
      return {
        customer_ref: known.customer_ref,
        tenant_id: systemConfig.tenant_id,
        system_id: systemConfig.system_id,
        is_known_customer: true,
        unit_context: known.unit_context,
      };
    }

    Logger.warn(`Unknown sender phone number ${fromE164} on valid tenant number`, {
      tenant_id: systemConfig.tenant_id,
      system_id: systemConfig.system_id,
    });

    // Unknown sender path: opaque reference, no guessed identity
    return {
      customer_ref: `opaque_unresolved_${fromE164.replace(/[^0-9]/g, '')}`,
      tenant_id: systemConfig.tenant_id,
      system_id: systemConfig.system_id,
      is_known_customer: false,
    };
  }
}
