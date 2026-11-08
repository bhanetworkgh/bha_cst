import { describe, it, expect, afterEach } from 'vitest';
import { publishTextTurn } from '../../engine/src/interfaces/sms/text_policy.js';
import { setActiveDashboardPublisher, CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';

// Every text writes one dashboard record (8 Nov 2026). The dashboard only takes
// the statuses ok, refused, step_up_required, onboarding and error, so a record
// with anything else would be refused there with a 422.
const DASHBOARD_STATUSES = ['ok', 'refused', 'step_up_required', 'onboarding', 'error'];

describe('text dashboard record', () => {
  afterEach(() => setActiveDashboardPublisher(null));

  const capture = () => {
    const events: any[] = [];
    const fake = { publishFireAndForget: (e: any) => { events.push(e); } } as unknown as CstDashboardPublisher;
    setActiveDashboardPublisher(fake);
    return events;
  };

  it('records a calls-only text as an sms turn with the message, reply and outcome', () => {
    const events = capture();
    publishTextTurn({ message_sid: 'SM1', tenant_id: 't1', from_e164: '+2348000000000', body: 'hello', reply: 'calls only', outcome: 'calls_only_sent' });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe('cst.turn');
    expect(e.channel).toBe('sms');
    expect(e.data.status).toBe('ok');
    expect(e.data.intent).toBe('calls_only_sent');
    expect(e.data.message).toBe('hello');
    expect(e.data.reply).toBe('calls only');
  });

  it('only ever uses a status the dashboard accepts', () => {
    const events = capture();
    for (const outcome of ['calls_only_sent', 'calls_only_already_sent', 'help_by_twilio', 'stop_by_cst', 'opted_out_silent']) {
      publishTextTurn({ message_sid: `SM_${outcome}`, tenant_id: 't1', from_e164: '+19452985504', body: 'x', reply: null, outcome });
    }
    for (const e of events) expect(DASHBOARD_STATUSES).toContain(e.data.status);
    expect(events.find((e) => e.data.intent === 'opted_out_silent').data.status).toBe('refused');
  });
});
