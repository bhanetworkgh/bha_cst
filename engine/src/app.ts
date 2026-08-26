import express, { Express } from 'express';
import { inboundRouter } from './transport/twilio/inbound.js';
import { outboundRouter } from './transport/twilio/outbound.js';
import { DbClient } from './db/client.js';

export function createApp(): Express {
  const app = express();

  // Twilio sends application/x-www-form-urlencoded webhooks
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Register routes
  app.use('/webhooks', inboundRouter);
  app.use('/webhooks', outboundRouter);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'bha-cst-engine' });
  });

  // Debug state endpoint — development and test environments ONLY (GAP-7 fix)
  // Returns in-memory state snapshot. Must never be live in production.
  app.get('/debug/state', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.status(200).json({
      conversations: DbClient.getAllConversations(),
      transcripts: DbClient.getAllTranscripts(),
      messages_in: DbClient.getAllMessagesIn(),
      messages_out: DbClient.getAllMessagesOut(),
    });
  });


  return app;
}
