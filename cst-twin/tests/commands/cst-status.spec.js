import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { cstStatusCommandCallback } from '../../listeners/commands/cst-status.js';

describe('commands', () => {
  let fakeAck;
  let fakeRespond;
  let fakeLogger;

  beforeEach(() => {
    fakeAck = mock.fn();
    fakeRespond = mock.fn();
    fakeLogger = {
      error: mock.fn(),
    };
  });

  it('should acknowledge and respond with cst status', async () => {
    await cstStatusCommandCallback({
      ack: fakeAck,
      respond: fakeRespond,
      logger: fakeLogger,
    });

    assert.strictEqual(fakeAck.mock.callCount(), 1);
    assert.strictEqual(fakeRespond.mock.callCount(), 1);

    const callArgs = fakeRespond.mock.calls[0].arguments[0];
    assert.strictEqual(callArgs.response_type, 'ephemeral');
    assert(callArgs.text.includes('Customer Service Twin (CST) Operational Status'));
  });

  it('should log error when ack throws exception', async () => {
    const testError = new Error('test exception');
    fakeAck = mock.fn(() => {
      throw testError;
    });

    await cstStatusCommandCallback({
      ack: fakeAck,
      respond: fakeRespond,
      logger: fakeLogger,
    });

    assert.strictEqual(fakeLogger.error.mock.callCount(), 1);
    assert.strictEqual(fakeLogger.error.mock.calls[0].arguments[0], testError);
  });
});
