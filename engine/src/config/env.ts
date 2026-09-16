import dotenv from 'dotenv';
import { z, ZodError } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── Twilio Transport Credentials ──────────────────────────────────────────
  TWILIO_ACCOUNT_SID:           z.string().min(1),
  TWILIO_AUTH_TOKEN:            z.string().min(1),
  TWILIO_MESSAGING_SERVICE_SID: z.string().min(1),

  // ── Database ───────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/bha_cst'),

  // ── System #1 (vFarm) Identity & Routing ──────────────────────────────────
  // Comma-separated E.164 numbers this system owns, e.g. +19715885823,+1999...
  VFARM_SYSTEM_ID:        z.string().min(1),
  VFARM_TENANT_ID:        z.string().min(1),
  VFARM_SYSTEM_NAME:      z.string().min(1),
  VFARM_PHONE_NUMBERS:    z.string().min(1),
  VFARM_ONBOARDING_REPLY: z.string().min(1),

  // ── System #1 (vFarm) External API Seams ──────────────────────────────────
  // Full URL to vFarm identity resolution endpoint
  VFARM_RESOLVE_ENDPOINT: z.string().url(),
  // Service-to-service API key for CST -> vFarm resolve calls
  VFARM_RESOLVE_API_KEY:  z.string().min(1),

  // ── BHARAG Knowledge RAG & Incidents.v0 ───────────────────────────────────
  // Base URL of BHARAG API server, e.g. http://localhost:5000/api/v0
  BHARAG_API_URL:       z.string().url(),
  // Workspace-scoped key issued by BHARAG to CST for vFarm knowledge corpus
  BHARAG_WORKSPACE_KEY: z.string().min(1),
  // Unified BHARAG Cluster Ask API URL & Key
  BHARAG_CLUSTER_URL:        z.string().url(),
  BHARAG_CLUSTER_KEY:        z.string().min(1),
  BHARAG_CLUSTER_TIMEOUT_MS: z.coerce.number().default(10000),

  // Public webhook URL override for production reverse proxies / load balancers
  PUBLIC_WEBHOOK_URL:        z.string().url().optional(),

  // ── Media Server & AWS S3 Bucket Configuration ────────────────────────────
  // Base URL for signed S3 image captures from the vFarm media server
  MEDIA_SERVER_URL:     z.string().url(),
  // Direct AWS S3 Bucket URL for MMS media file storage (Spec §3)
  S3_MEDIA_BUCKET_URL:  z.string().url().default('https://vfarm-media-captures.s3.us-east-1.amazonaws.com'),
  // AWS S3 Bucket Name where camera captures and MMS photos are uploaded
  AWS_S3_BUCKET_NAME:   z.string().default('vfarm-media-captures'),
  // AWS Region where the S3 bucket is hosted
  AWS_REGION:           z.string().default('us-east-1'),

  // ── ElevenLabs Voice Clone Configuration ──────────────────────────────────
  ELEVENLABS_API_KEY:        z.string().optional(),
  ELEVENLABS_BASE_URL:       z.string().url().optional(),
  ELEVENLABS_MODEL_ID:       z.string().optional(),
  ELEVENLABS_VOICE_ID:       z.string().optional(),
  VFARM_ELEVENLABS_VOICE_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _cached: Env | null = null;

/**
 * Parse and validate all required env vars.
 * Throws a descriptive error listing every missing/invalid field — nothing runs
 * with bad or absent configuration.  Cached after first successful parse.
 */
export function getEnv(): Env {
  if (_cached) return _cached;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = (result.error as ZodError).errors
      .map((e) => `  • ${e.path.join('.')}: ${e.message}`)
      .join('\n');

    throw new Error(
      `\n\n❌  bha-cst: Required environment variables are missing or invalid.\n` +
      `   Check your .env file and ensure ALL of the following are set:\n\n` +
      `${missing}\n\n` +
      `   Reference: .env.example for the full list and instructions.\n`
    );
  }

  _cached = result.data;
  return _cached;
}

/** Reset cached env (for tests that manipulate process.env) */
export function resetEnvCache(): void {
  _cached = null;
}
