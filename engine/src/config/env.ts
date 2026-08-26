import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TWILIO_ACCOUNT_SID: z.string().default('AC00000000000000000000000000000000'),
  TWILIO_AUTH_TOKEN: z.string().default('00000000000000000000000000000000'),
  TWILIO_MESSAGING_SERVICE_SID: z.string().default('MG00000000000000000000000000000000'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/bha_cst'),
  VFARM_RESOLVE_ENDPOINT: z.string().default('http://localhost:4000/api/v1/customers/resolve'),
  VFARM_RESOLVE_API_KEY: z.string().default('vfarm_cst_secret_key'),
});

export type Env = z.infer<typeof envSchema>;

export function getEnv(): Env {
  return envSchema.parse(process.env);
}
