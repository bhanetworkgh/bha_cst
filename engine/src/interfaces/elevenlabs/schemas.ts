import { z } from 'zod';

export const ElevenLabsTranscriptMessageSchema = z.object({
  role: z.string(),
  // ElevenLabs sends null here on a tool call or tool result turn. A null must
  // not refuse the whole post-call report (every report with a tool turn
  // answered 400 from 4 Nov 2026), so it is accepted and left out downstream.
  message: z.string().nullish(),
  time_in_call_secs: z.number().optional(),
}).passthrough();
export type ElevenLabsTranscriptMessage = z.infer<typeof ElevenLabsTranscriptMessageSchema>;

export const ElevenLabsAnalysisSchema = z.record(z.string(), z.unknown());
export type ElevenLabsAnalysis = z.infer<typeof ElevenLabsAnalysisSchema>;

export const ElevenLabsMetadataSchema = z.record(z.string(), z.unknown());
export type ElevenLabsMetadata = z.infer<typeof ElevenLabsMetadataSchema>;

export const ElevenLabsDataSchema = z.object({
  agent_id: z.string().optional(),
  conversation_id: z.string().optional(),
  call_id: z.string().optional(),
  status: z.string().optional(),
  start_time_unix_secs: z.number().optional(),
  call_duration_secs: z.number().optional(),
  transcript: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  message_history: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  analysis: ElevenLabsAnalysisSchema.optional(),
  metadata: ElevenLabsMetadataSchema.optional(),
}).passthrough();
export type ElevenLabsData = z.infer<typeof ElevenLabsDataSchema>;

export const ElevenLabsPostCallWebhookPayloadSchema = z.object({
  type: z.string().default('post_call_transcription'),
  event_timestamp: z.number().optional(),
  data: ElevenLabsDataSchema.optional(),
  // Top-level fallbacks (for compatibility with flat payloads and tests)
  call_id: z.string().optional(),
  conversation_id: z.string().optional(),
  agent_id: z.string().optional(),
  start_time_unix_secs: z.number().optional(),
  call_duration_secs: z.number().optional(),
  transcript: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  message_history: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  analysis: ElevenLabsAnalysisSchema.optional(),
  metadata: ElevenLabsMetadataSchema.optional(),
}).passthrough().refine((payload) => {
  const d = payload.data;
  return Boolean(payload.call_id || payload.conversation_id || d?.conversation_id || d?.call_id);
}, {
  message: 'Either call_id or conversation_id must be provided in the payload or payload.data',
  path: ['conversation_id'],
});

export type ElevenLabsPostCallWebhookPayload = z.infer<typeof ElevenLabsPostCallWebhookPayloadSchema>;
