import { z } from 'zod';

export const ElevenLabsTranscriptMessageSchema = z.object({
  role: z.string(),
  message: z.string(),
  time_in_call_secs: z.number().optional(),
});
export type ElevenLabsTranscriptMessage = z.infer<typeof ElevenLabsTranscriptMessageSchema>;

export const ElevenLabsAnalysisSchema = z.object({
  transcript_summary: z.string().optional(),
  call_successful: z.union([z.string(), z.boolean()]).optional(),
  evaluation_criteria_results: z.record(z.string(), z.unknown()).optional(),
  data_collection_results: z.record(z.string(), z.unknown()).optional(),
});
export type ElevenLabsAnalysis = z.infer<typeof ElevenLabsAnalysisSchema>;

export const ElevenLabsMetadataSchema = z.object({
  custom_variables: z.record(z.string(), z.unknown()).optional(),
  caller_id: z.string().optional(),
});
export type ElevenLabsMetadata = z.infer<typeof ElevenLabsMetadataSchema>;

export const ElevenLabsPostCallWebhookPayloadSchema = z.object({
  type: z.string().default('post_call_transcription'),
  call_id: z.string().optional(),
  conversation_id: z.string().optional(),
  agent_id: z.string().optional(),
  start_time_unix_secs: z.number().optional(),
  call_duration_secs: z.number().optional(),
  transcript: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  message_history: z.array(ElevenLabsTranscriptMessageSchema).optional(),
  analysis: ElevenLabsAnalysisSchema.optional(),
  metadata: ElevenLabsMetadataSchema.optional(),
}).refine((data) => Boolean(data.call_id || data.conversation_id), {
  message: 'Either call_id or conversation_id must be provided in the payload',
  path: ['conversation_id'],
});

export type ElevenLabsPostCallWebhookPayload = z.infer<typeof ElevenLabsPostCallWebhookPayloadSchema>;

