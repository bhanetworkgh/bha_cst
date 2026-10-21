/**
 * OpenAPI 3.0.3 specification for the BHA Customer Service Twin (CST) Engine.
 *
 * This spec is consumed by swagger-ui-express to serve interactive API docs at
 * GET /api-docs and the raw JSON at GET /api-docs.json.
 *
 * All schemas are defined inline under `components.schemas` and referenced
 * throughout using $ref to keep individual path entries concise.
 */

export const swaggerSpec = {
  openapi: '3.0.3',

  info: {
    title: 'BHA Customer Service Twin (CST) Engine',
    version: '1.0.0',
    description: `
## Overview

The **BHA Customer Service Twin (CST) Engine** is a multi-tenant, AI-powered SMS conversation engine.
It receives inbound Twilio SMS webhooks, resolves the sender's identity and role, routes the message
through an 8-step pipeline, and dispatches a contextually relevant reply via the Twilio transport worker.

## Architecture summary

- **Inbound path**: Twilio → \`POST /webhooks/twilio/sms\` → Signature verification → Tenancy resolution → Identity resolution → Intent routing → Connector dispatch
- **Delivery callbacks**: Twilio → \`POST /webhooks/twilio/delivery-status\` → DB status update → \`cst.delivery\` publication, attributed from the persisted outbound row
- **Outbound worker**: Background loop every 5 s polls the DB for \`pending\`/\`queued\` messages and delivers them via Twilio. A claimed row holds a 5-minute lease; a row whose worker died mid-send is reclaimed and re-queued.

## Security

All Twilio webhook endpoints validate the \`X-Twilio-Signature\` header before any business logic runs.
Requests with an invalid or missing signature are rejected with \`403 FORBIDDEN\`.

## Multi-tenancy

Tenant scope is resolved entirely **server-side**. On the inbound path it comes from the receiving
Twilio number (\`To\`); on the delivery-status path it comes from the persisted outbound message
row, because in a status callback \`To\` is the recipient rather than the sending number.
Clients cannot inject or override the tenant_id.

## Environments

| Environment | Base URL |
|-------------|----------|
| Production  | \`https://bha-cst.onrender.com\` |
| Local Dev   | \`http://localhost:3000\` |
    `.trim(),
    contact: {
      name: 'BHA Engineering',
      email: 'engineering@bha.network',
    },
    license: {
      name: 'ISC',
    },
  },

  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local development server',
    },
    {
      url: 'https://bha-cst.onrender.com',
      description: 'Production (Render)',
    },
  ],

  tags: [
    {
      name: 'Webhooks',
      description:
        'Endpoints called by Twilio. All requests must carry a valid `X-Twilio-Signature` header.',
    },
    {
      name: 'Health',
      description: 'Liveness and readiness probes used by Render / AWS ALB.',
    },
    {
      name: 'Voice',
      description: 'ElevenLabs voice clone speech synthesis and interactive voice lane endpoints.',
    },
    {
      name: 'Debug',
      description:
        'Development-only endpoints that expose in-memory state. **Never available in production.**',
    },
  ],

  // ── Reusable Components ───────────────────────────────────────────────────
  components: {
    securitySchemes: {
      TwilioSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Twilio-Signature',
        description:
          'HMAC-SHA1 signature computed by Twilio over the full request URL and sorted POST parameters using the account AUTH TOKEN. See https://www.twilio.com/docs/usage/webhooks/webhooks-security.',
      },
    },

    schemas: {
      // ── Inbound SMS Webhook Body ──────────────────────────────────────────
      TwilioSmsWebhookBody: {
        type: 'object',
        description:
          'Form-encoded payload that Twilio POSTs when an SMS is received on one of the registered system numbers.',
        required: ['MessageSid', 'AccountSid', 'From', 'To', 'Body'],
        properties: {
          MessageSid: {
            type: 'string',
            example: 'SM1234567890abcdef1234567890abcdef',
            description: 'Unique Twilio message identifier used for deduplication.',
          },
          SmsSid: {
            type: 'string',
            example: 'SM1234567890abcdef1234567890abcdef',
            description: 'Alias for MessageSid (legacy field, same value).',
          },
          AccountSid: {
            type: 'string',
            example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            description: 'Twilio Account SID that owns the receiving number.',
          },
          From: {
            type: 'string',
            example: '+12025551234',
            description: 'Sender phone number in E.164 format.',
          },
          To: {
            type: 'string',
            example: '+19715885823',
            description:
              'Receiving system phone number in E.164 format. Used server-side to resolve tenant and system context.',
          },
          Body: {
            type: 'string',
            example: 'What is the temperature in bay 3?',
            description: 'SMS message text. Intent classification is run against this field.',
          },
          NumMedia: {
            type: 'string',
            example: '0',
            description: 'Number of media attachments (MMS). Integer encoded as string.',
          },
          'MediaUrl0': {
            type: 'string',
            format: 'uri',
            example: 'https://api.twilio.com/2010-04-01/Accounts/.../Messages/.../Media/ME...',
            description:
              'URL of the first media attachment. Additional items follow the pattern MediaUrl1, MediaUrl2, etc.',
          },
          'MediaContentType0': {
            type: 'string',
            example: 'image/jpeg',
            description: 'MIME type of the first media attachment.',
          },
          MessagingServiceSid: {
            type: 'string',
            example: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            description: 'Optional. Twilio Messaging Service SID if the message was sent via a messaging service.',
          },
        },
        additionalProperties: true,
      },

      // ── Delivery Status Callback Body ─────────────────────────────────────
      TwilioDeliveryStatusBody: {
        type: 'object',
        description:
          'Form-encoded payload Twilio POSTs to report the delivery status of an outbound message.',
        required: ['MessageSid', 'MessageStatus'],
        properties: {
          MessageSid: {
            type: 'string',
            example: 'SM1234567890abcdef1234567890abcdef',
            description: 'Twilio SID of the outbound message being reported on.',
          },
          SmsSid: {
            type: 'string',
            example: 'SM1234567890abcdef1234567890abcdef',
            description: 'Legacy alias for MessageSid.',
          },
          MessageStatus: {
            type: 'string',
            enum: ['queued', 'failed', 'sent', 'delivered', 'undelivered', 'receiving', 'received'],
            example: 'delivered',
            description: 'Current Twilio delivery status. The engine maps this to its internal status enum.',
          },
          To: {
            type: 'string',
            example: '+12025551234',
            description:
              'Destination phone number. Used server-side to resolve the tenant_id from the system registry.',
          },
          From: {
            type: 'string',
            example: '+19715885823',
            description: 'Sending system phone number (the CST Twilio number).',
          },
          ErrorCode: {
            type: 'string',
            example: '30003',
            description:
              'Twilio error code if the message failed or was undelivered. Stored in the database error_message field.',
          },
          AccountSid: {
            type: 'string',
            example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        },
        additionalProperties: true,
      },

      // ── Health Response ────────────────────────────────────────────────────
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            example: 'ok',
          },
          service: {
            type: 'string',
            example: 'bha-cst-engine',
          },
        },
        required: ['status', 'service'],
      },

      // ── Debug State Response ───────────────────────────────────────────────
      DebugStateResponse: {
        type: 'object',
        description: 'In-memory DB snapshot. Only returned in development / test environments.',
        properties: {
          conversations: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: 'All active conversation records keyed by conversation_id.',
          },
          transcripts: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: 'All message transcript entries across all conversations.',
          },
          messages_in: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: 'Deduplicated inbound message log.',
          },
          messages_out: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: 'Outbound message queue state including retry counts and status.',
          },
        },
      },

      // ── Error Responses ────────────────────────────────────────────────────
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'BAD_REQUEST',
            description: 'Machine-readable error code.',
          },
          message: {
            type: 'string',
            example: 'Missing receiving To number',
            description: 'Human-readable description of the error. May be omitted for security-sensitive errors.',
          },
        },
        required: ['error'],
      },

      RateLimitErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'TOO_MANY_REQUESTS',
          },
          message: {
            type: 'string',
            example: 'Rate limit exceeded. Try again later.',
          },
        },
        required: ['error', 'message'],
      },

      // ── Voice Lane Schemas ────────────────────────────────────────────────
      AudioSpeakRequest: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to synthesize into spoken audio via Jason\'s ElevenLabs voice clone.',
            example: 'Your bay 4 irrigation cycle completed successfully.',
          },
          voiceId: {
            type: 'string',
            description: 'Optional override for ElevenLabs voice ID pointer.',
            example: 'Hmy97GCI840wuICQesiM',
          },
          modelId: {
            type: 'string',
            description: 'Optional override for ElevenLabs model ID.',
            example: 'eleven_turbo_v2_5',
          },
        },
        required: ['text'],
      },

      AudioSpeakResponse: {
        type: 'object',
        properties: {
          audioBase64: {
            type: 'string',
            description: 'Base64-encoded audio payload.',
          },
          mimeType: {
            type: 'string',
            example: 'audio/mpeg',
          },
        },
        required: ['audioBase64', 'mimeType'],
      },

      VoiceTurnRequest: {
        type: 'object',
        properties: {
          from_e164: {
            type: 'string',
            description: 'Caller phone number in E.164 format.',
            example: '+15551234567',
          },
          to_e164: {
            type: 'string',
            description: 'System receiving phone number in E.164 format.',
            example: '+19715885823',
          },
          speech_text: {
            type: 'string',
            description: 'Transcribed speech text from caller.',
            example: 'What is the temperature in the bay?',
          },
          correlation_id: {
            type: 'string',
            description: 'Optional correlation ID for tracing across CST and audit ledgers.',
            example: 'voice_turn_abc123',
          },
        },
        required: ['from_e164', 'to_e164', 'speech_text'],
      },

      VoiceLaneHealthResponse: {
        type: 'object',
        properties: {
          service: { type: 'string', example: 'bha-cst-engine' },
          voice_lane: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['healthy', 'degraded', 'unconfigured'],
                example: 'healthy',
              },
              can_route_voice: {
                type: 'boolean',
                example: true,
              },
              clone_configured: {
                type: 'boolean',
                example: true,
              },
              voice_id: {
                type: 'string',
                nullable: true,
                example: 'Hmy9...esiM',
              },
              successful_deliveries_24h: {
                type: 'number',
                example: 1,
              },
              last_successful_spoken_delivery: {
                type: 'string',
                nullable: true,
                example: '2026-09-17T00:30:00.000Z',
              },
              reason: {
                type: 'string',
                example: 'Voice clone configured and at least one successful delivery verified in last 24 hours.',
              },
              computed_at: {
                type: 'string',
                example: '2026-09-17T00:45:00.000Z',
              },
            },
            required: ['status', 'can_route_voice', 'clone_configured', 'successful_deliveries_24h', 'reason'],
          },
        },
        required: ['service', 'voice_lane'],
      },
    },
  },

  // ── API Paths ─────────────────────────────────────────────────────────────
  paths: {

    // ── POST /webhooks/twilio/sms ──────────────────────────────────────────
    '/webhooks/twilio/sms': {
      post: {
        tags: ['Webhooks'],
        summary: 'Receive inbound SMS from Twilio',
        operationId: 'twilioInboundSms',
        description: `
**Caller**: Twilio (automated — not called by API consumers directly)

**Pipeline (8 steps)**:
1. \`verifyTwilioSignature\` middleware — validates \`X-Twilio-Signature\`; rejects if invalid
2. Tenancy resolution — server-side lookup of tenant + system context from the \`To\` phone number
3. \`enforceTenancyGate\` middleware — ensures tenant context is present (fail-closed)
4. Message normalisation — converts Twilio form payload to internal \`InboundMessage\`
5. Deduplication — MessageSid checked against DB; duplicate returns \`204\` immediately
6. HTTP \`204\` returned to Twilio **before** async processing begins (prevents Twilio timeout)
7. \`setImmediate\` async pipeline: identity resolution → intent detection → connector dispatch
8. Outbound worker triggered inline to deliver the queued reply

**Rate limit**: 120 requests / minute per source IP on all \`/webhooks/*\` paths.

**Idempotency**: Replaying the same \`MessageSid\` is safe — duplicate messages are silently dropped.
        `.trim(),
        security: [{ TwilioSignature: [] }],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: { $ref: '#/components/schemas/TwilioSmsWebhookBody' },
              example: {
                MessageSid: 'SM1234567890abcdef1234567890abcdef',
                AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                From: '+12025551234',
                To: '+19715885823',
                Body: 'What is the temperature in bay 3?',
                NumMedia: '0',
              },
            },
          },
        },
        responses: {
          '204': {
            description:
              'Message accepted. Twilio receives this response immediately. Processing continues asynchronously in the background.',
          },
          '400': {
            description: 'Bad request — missing required fields (e.g. no `To` number in body).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'BAD_REQUEST', message: 'Missing receiving To number' },
              },
            },
          },
          '403': {
            description:
              'Invalid Twilio signature — request rejected before any DB access. Also returned if server-side tenancy gate fails.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                examples: {
                  InvalidSignature: {
                    summary: 'Twilio signature mismatch',
                    value: { error: 'FORBIDDEN', message: 'Invalid Twilio signature' },
                  },
                  TenantScopeViolation: {
                    summary: 'Tenant scope not resolved',
                    value: {
                      error: 'TENANT_SCOPE_VIOLATION',
                      message: 'Unresolved server-side tenant scope',
                    },
                  },
                },
              },
            },
          },
          '404': {
            description:
              'Unknown receiving number — the `To` phone number is not registered to any system in the registry. No DB writes occur.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'SYSTEM_NOT_FOUND', message: 'Unknown receiving number' },
              },
            },
          },
          '429': {
            description: 'Rate limit exceeded — more than 120 requests/minute from the same source IP.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RateLimitErrorResponse' },
                example: { error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Try again later.' },
              },
            },
          },
          '500': {
            description: 'Internal server error during webhook ingestion.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'INTERNAL_SERVER_ERROR' },
              },
            },
          },
        },
      },
    },

    // ── POST /webhooks/twilio/delivery-status ──────────────────────────────
    '/webhooks/twilio/delivery-status': {
      post: {
        tags: ['Webhooks'],
        summary: 'Twilio delivery status callback',
        operationId: 'twilioDeliveryStatus',
        description: `
**Caller**: Twilio (automated — triggered when an outbound message transitions state)

Updates the delivery status of a previously sent outbound message in both the outbound queue table
and the conversation transcript.

**Status mapping**:

| Twilio \`MessageStatus\` | Internal status |
|-------------------------|-----------------|
| \`accepted\`, \`queued\`  | \`queued\`       |
| \`sent\`, \`partial\`    | \`sent\`         |
| \`delivered\`, \`read\`   | \`delivered\`    |
| \`undelivered\`          | \`undelivered\`  |
| \`failed\`, \`canceled\`  | \`failed\`       |
| \`sending\`              | *(no CST equivalent — state unchanged, nothing published)* |
| *(unknown)*             | *(no CST equivalent — state unchanged, nothing published)* |

An unrecognised status is NEVER treated as \`delivered\`. Delivery state is monotonic, so
recording a \`queued\` message as \`delivered\` would both report a false delivery and suppress the
genuine \`sent\`/\`delivered\` callbacks that follow it.

**Attribution**: the persisted outbound message row is the only attribution source. It is the
message that was actually sent and it carries the tenant, project and turn the send was authorised
under. In a Twilio status callback \`To\` is the **recipient** of the message and \`From\` is the
**sending** number, so \`To\` is never used to resolve tenancy. When the stored row carries no
tenancy the callback is acknowledged to Twilio, recorded as a refusal, and no \`cst.delivery\` event
is published — the event is never published against an inferred project.

An \`ErrorCode\` value, if present, is stored in the \`error_message\` field for audit and debugging.
        `.trim(),
        security: [{ TwilioSignature: [] }],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: { $ref: '#/components/schemas/TwilioDeliveryStatusBody' },
              example: {
                MessageSid: 'SM1234567890abcdef1234567890abcdef',
                MessageStatus: 'delivered',
                To: '+12025551234',
                From: '+19715885823',
                AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              },
            },
          },
        },
        responses: {
          '204': {
            description: 'Status update acknowledged. No response body.',
          },
          '400': {
            description: 'Missing required `MessageSid` or `MessageStatus` fields.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'BAD_REQUEST', message: 'Missing MessageSid or MessageStatus' },
              },
            },
          },
          '403': {
            description: 'Invalid Twilio signature.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'FORBIDDEN', message: 'Invalid Twilio signature' },
              },
            },
          },
          '429': {
            description: 'Rate limit exceeded.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RateLimitErrorResponse' },
              },
            },
          },
        },
      },
    },

    // ── GET /health ────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness health check',
        operationId: 'getHealth',
        description:
          'Returns `200 OK` when the server is running. Used by Render and AWS ALB to determine instance health. Does **not** check database connectivity.',
        responses: {
          '200': {
            description: 'Server is live.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: { status: 'ok', service: 'bha-cst-engine' },
              },
            },
          },
        },
      },
    },

    // ── GET /health/voice ──────────────────────────────────────────────────
    '/health/voice': {
      get: {
        tags: ['Health', 'Voice'],
        summary: 'Destiny voice-lane health signal',
        operationId: 'getVoiceHealth',
        description:
          'Evaluates whether front-line voice routing is permitted based on: clone configured + at least one successful spoken delivery in the last 24h. If false, returns 503 and signals NS/RT to keep CST in SMS-only mode.',
        responses: {
          '200': {
            description: 'Voice lane is healthy and verified for front-line routing.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VoiceLaneHealthResponse' },
              },
            },
          },
          '503': {
            description: 'Voice lane is unconfigured or degraded (0 successful deliveries in 24h). CST remains SMS-only.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VoiceLaneHealthResponse' },
              },
            },
          },
        },
      },
    },

    // ── POST /audio/speak ──────────────────────────────────────────────────
    '/audio/speak': {
      post: {
        tags: ['Voice'],
        summary: 'Direct speech synthesis via Jason\'s voice clone',
        operationId: 'audioSpeak',
        description:
          'Synthesizes authorized text into base64 audio via ElevenLabs using Jason\'s voice clone pointer. Fails closed if clone is unconfigured or synthesis fails.\n\n' +
          'REQUIRES the `x-cst-api-key` header (shared secret `CST_API_KEY`). The caller may supply `voiceId` directly, so this route must be authenticated. If `CST_API_KEY` is not configured the route fails closed with 503 CONFIG_MISSING.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AudioSpeakRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Audio successfully synthesized.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AudioSpeakResponse' },
              },
            },
          },
          '400': {
            description: 'Missing or invalid request parameters.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '502': {
            description: 'Audio synthesis failed. Spoken turn dropped (fail-closed, no generic fallback).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },

    // ── POST /voice/turn ───────────────────────────────────────────────────
    '/voice/turn': {
      post: {
        tags: ['Voice'],
        summary: 'Interactive voice lane turn through CST orchestrator',
        operationId: 'voiceTurn',
        description:
          'Passes caller voice turn through CST authorization chain, intent router, and BHARAG connectors. Synthesizes audio only if authorized. Strictly fails closed.\n\n' +
          'REQUIRES the `x-cst-api-key` header (shared secret `CST_API_KEY`). The caller asserts `from_e164`, and the speaker identity — role, permissions and farm scope — is resolved from that number, so the request must be authenticated before it is trusted. If `CST_API_KEY` is not configured the route fails closed with 503 CONFIG_MISSING. The Twilio-hosted equivalents (`/webhooks/twilio/voice/turn`, `/twilio/voice/turn`) are protected by Twilio request signature verification instead.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VoiceTurnRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Voice turn successfully processed and synthesized.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'synthesized' },
                    text: { type: 'string' },
                    audioBase64: { type: 'string' },
                    mimeType: { type: 'string', example: 'audio/mpeg' },
                    correlation_id: { type: 'string' },
                  },
                },
              },
            },
          },
          '403': {
            description: 'CST authorization chain refused the answer (e.g. unauthorized role or sensitive write). Spoken turn refused.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '422': {
            description: 'System lacks voice clone configuration. Spoken turn dropped (strictly no generic voice fallback).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '502': {
            description: 'Voice synthesis failed upstream. Turn dropped.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },

    // ── GET /debug/state ───────────────────────────────────────────────────
    '/debug/state': {
      get: {
        tags: ['Debug'],
        summary: 'In-memory state snapshot',
        operationId: 'getDebugState',
        description: `
**Available in**: \`development\` and \`test\` environments only.

Returns a full dump of the in-memory DbClient state — conversations, transcripts, inbound messages,
and the outbound queue. Used for local debugging and integration test assertions.

> ⚠️ **This endpoint returns \`404 NOT_FOUND\` in production.** No data is ever exposed in a production environment.
        `.trim(),
        responses: {
          '200': {
            description: 'Full in-memory state dump (dev/test only).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DebugStateResponse' },
                example: {
                  conversations: [
                    {
                      conversation_id: 'conv_abc123',
                      tenant_id: 'org-vfarm-001',
                      workspace_id: 'ws-vfarm-main',
                      customer_ref: '+12025551234',
                      created_at: '2026-01-01T00:00:00.000Z',
                    },
                  ],
                  transcripts: [],
                  messages_in: [],
                  messages_out: [],
                },
              },
            },
          },
          '404': {
            description: 'Endpoint is disabled in production.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: { error: 'NOT_FOUND' },
              },
            },
          },
        },
      },
    },
  },
} as const;
