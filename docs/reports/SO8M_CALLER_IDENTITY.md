# SO8M caller identity correction — local review draft

The confirmed fabricated caller fallback is in `engine/src/interfaces/elevenlabs/service.ts`, not a verified singular `schema.ts` file. It previously substituted `+15550000000` when no recognized provider phone field was present.

This change removes that fallback. It preserves field precedence: custom_variables.caller_phone, phone_call.external_number, metadata.caller_id. The first non-null/nonempty value must be a string in E.164 syntax (plus, nonzero first digit, 2–15 digits). Whitespace around a valid string is trimmed. Invalid higher-priority values do not silently select another identity.

Missing or invalid identity returns a failed processing result with CALLER_IDENTITY_MISSING or CALLER_IDENTITY_INVALID before events, DB writes, dashboard publication or Slack dispatch. The existing HTTP handler returns 500 for that result. No successful idempotency entry is created, so a corrected retry can be processed.

Review tradeoff: calls without usable phone identity will no longer be recorded/delivered by this handler. Provider retries may continue; no automatic recovery, retention or quarantine is added here. The current customer contract requires a nonempty phone number. Supporting anonymous calls without losing their transcripts requires a separately reviewed contract/persistence design; inserting a different placeholder would not solve identity fabrication.

Syntactic phone validation does not establish customer ownership, tenant membership or a known customer. Existing role/is_known attribution is outside this focused correction and is not certified by these tests.

Local tests cover each supported field, absent and malformed values, no side effects on failure, source precedence, corrected retry and deduplication. No production test or deployment is included. This draft addresses the identified fallback only; it does not close all SO8M or PBT5 requirements.
