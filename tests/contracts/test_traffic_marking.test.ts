import { describe, it, expect } from 'vitest';
import {
  createCstTurnEventV1,
  createCstDeliveryEventV1,
  CustomerPayload,
} from '../../engine/src/contracts/index.js';
import { serializeForDashboard } from '../../engine/src/publishers/dashboard.js';

describe('Test / Live Traffic Separation & Serialization', () => {
  const sampleCustomer: CustomerPayload = {
    customer_ref: 'cust_vfarm_001',
    phone_e164: '+15551234567',
    role: 'owner',
    is_known: true,
    tenant_id: 'tenant_vfarm',
    project_id: 'proj_vfarm_primary',
  };

  it('preserves test: true marker through serializeForDashboard for cst.turn events', () => {
    const event = createCstTurnEventV1({
      id: 'evt_test_001',
      tenant_id: 'tenant_vfarm',
      project_id: 'proj_vfarm_primary',
      correlation_id: 'corr_test_001',
      channel: 'sms',
      customer: sampleCustomer,
      turn: {
        turn_id: 'turn_test_001',
        direction: 'inbound',
        channel: 'sms',
        status: 'ok',
        text: 'hello from automated test',
        test: true,
      },
    });

    const serialized = serializeForDashboard(event);
    expect(serialized.event_type).toBe('cst.turn');
    expect(serialized.turn_id).toBe('turn_test_001');
    expect(serialized.test).toBe(true);
  });

  it('preserves test: true marker through serializeForDashboard for cst.delivery events', () => {
    const event = createCstDeliveryEventV1({
      id: 'evt_del_001',
      tenant_id: 'tenant_vfarm',
      project_id: 'proj_vfarm_primary',
      correlation_id: 'corr_del_001',
      channel: 'sms',
      customer: sampleCustomer,
      delivery: {
        delivery_id: 'del_test_001',
        channel: 'sms',
        to: '+15551234567',
        status: 'delivered',
        test: true,
      },
    });

    const serialized = serializeForDashboard(event);
    expect(serialized.event_type).toBe('cst.delivery');
    expect(serialized.delivery_id).toBe('del_test_001');
    expect(serialized.test).toBe(true);
  });

  it('does NOT mark live events with test: true when omitted', () => {
    const event = createCstTurnEventV1({
      id: 'evt_live_001',
      tenant_id: 'tenant_vfarm',
      project_id: 'proj_vfarm_primary',
      correlation_id: 'corr_live_001',
      channel: 'sms',
      customer: sampleCustomer,
      turn: {
        turn_id: 'turn_live_001',
        direction: 'inbound',
        channel: 'sms',
        status: 'ok',
        text: 'real live customer message',
      },
    });

    const serialized = serializeForDashboard(event);
    expect(serialized.test).toBeUndefined();
  });
});
