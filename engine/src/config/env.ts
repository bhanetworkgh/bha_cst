import dotenv from 'dotenv';
import { z, ZodError } from 'zod';

dotenv.config();

// Treat `KEY=` (empty) in a .env file as "not set" for optional variables.
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

/**
 * vFarm Management API (verified OpenAPI contract) — all optional.
 * Live vFarm mode is ON iff VFARM_API_BASE_URL is set. No URL is hardcoded in code:
 *   development → https://bhavfarm1.duckdns.org   (set in .env)
 *   production  → https://api.vfarm.bhanetwork.org (set in the deploy environment)
 * Credentials are the two mechanisms declared by the vFarm OpenAPI:
 *   VFARM_API_JWT      → `Authorization: Bearer <JWT>`
 *   VFARM_API_FARM_KEY → `X-Farm-Key: <key>`
 * (VFARM_RESOLVE_ENDPOINT / VFARM_RESOLVE_API_KEY are the legacy phone-resolve seam; they are
 *  a full endpoint URL + `x-api-key`, not a base URL / JWT / X-Farm-Key, so they are NOT reused.)
 */
const vfarmApiEnvShape = {
  VFARM_API_BASE_URL:   optionalEnv(z.string().url()),
  VFARM_API_JWT:        optionalEnv(z.string().min(1)),
  VFARM_API_FARM_KEY:   optionalEnv(z.string().min(1)),
  VFARM_API_TIMEOUT_MS: optionalEnv(z.coerce.number().int().positive()),
};

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

  // ── System #1 (vFarm) Management API — verified OpenAPI contract (all optional) ─
  ...vfarmApiEnvShape,

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

  // ── Engine Dashboard Event Publisher ──────────────────────────────────────
  ENGINE_DASHBOARD_URL:      optionalEnv(z.string().url()),
  ENGINE_DASHBOARD_KEY:      optionalEnv(z.string().min(1)),
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

const vfarmApiEnvSchema = z.object(vfarmApiEnvShape);
export type VfarmApiEnv = z.infer<typeof vfarmApiEnvSchema>;

/**
 * Read ONLY the vFarm Management API variables from process.env (uncached, so env changes apply).
 * Deliberately independent of getEnv(): it never requires the unrelated Twilio/BHARAG variables.
 * Error text lists variable names + zod reasons only — never the values (JWT / key safety).
 */
export function getVfarmApiEnv(): VfarmApiEnv {
  const result = vfarmApiEnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`bha-cst: invalid vFarm API configuration (${issues})`);
  }
  return result.data;
}