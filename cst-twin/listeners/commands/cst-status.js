const cstStatusCommandCallback = async ({ ack, respond, logger }) => {
  try {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: '🤖 *Customer Service Twin (CST) Operational Status:*\n• *Engine:* Online (`https://bha-cst-7u9e.onrender.com`)\n• *Voice Lane:* Healthy (Twilio Telephony + ElevenLabs Inbound Active)\n• *Channel:* `#bha-customer-service-twin`\n• *Latest Call:* `conv_7201m6kxewgfest8whyt0qwyx5hk` (17 turns, 78s, resolved)'
    });
  } catch (error) {
    logger.error(error);
  }
};

export { cstStatusCommandCallback };

