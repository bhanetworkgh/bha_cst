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
- **Delivery callbacks**: Twilio → \`POST /webhooks/twilio/delivery-status\` → DB status update
- **Outbound worker**: Background loop every 5 s polls the DB for \`pending\` messages and delivers them via Twilio

## Security

All Twilio webhook endpoints validate the \`X-Twilio-Signature\` header before any business logic runs.
Requests with an invalid or missing signature are rejected with \`403 FORBIDDEN\`.

## Multi-tenancy

Tenant scope is resolved entirely **server-side** from the receiving Twilio number (\`To\` field).
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
| \`sent\`                 | \`sent\`         |
| \`delivered\`            | \`delivered\`    |
| \`failed\`               | \`failed\`       |
| \`undelivered\`          | \`undelivered\`  |
| (all others)            | \`delivered\`    |

Tenant context is resolved server-side from the \`To\` parameter (the outbound sending number).
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
