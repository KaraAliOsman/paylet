import { z } from "zod";

/** Development-only default; a public deployment must set its own (see unsafeConfig). */
export const DEFAULT_HASH_SECRET = "paylet-dev-secret";

const schema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(10),
  PAYPAL_CLIENT_SECRET: z.string().min(10),
  PAYPAL_WEBHOOK_ID: z.string().optional().default(""),
  AI_BASE_URL: z.string().url().default("https://api.primalabs.ai/v1"),
  AI_MODEL: z.string().default("primalabs-ai/MiMo-V2.6-Pro"),
  AI_API_KEY: z.string().optional().default(""),
  AI_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(600),
  PUBLIC_URL: z.string().url().default("http://localhost:8790"),
  PORT: z.coerce.number().int().default(8790),
  DATA_DIR: z.string().default("./data"),
  HASH_SECRET: z.string().min(8).default(DEFAULT_HASH_SECRET),
  /** Optional owner key that opens every seller console (survives restarts on ephemeral hosting). */
  SELLER_ADMIN_KEY: z.string().min(16).optional(),
});

export const env = schema.parse(process.env);
export type Env = typeof env;

/** P2-14: a public (https) deployment must not run with the built-in HMAC secret: payer/email hashes would be
 *  reproducible by anyone who reads this repo. Returns the reason to refuse to boot, or null. */
export function unsafeConfig(e: Pick<Env, "HASH_SECRET" | "PUBLIC_URL">): string | null {
  if (e.PUBLIC_URL.startsWith("https://") && e.HASH_SECRET === DEFAULT_HASH_SECRET) {
    return "HASH_SECRET is the built-in development default while PUBLIC_URL is https. Set a long random HASH_SECRET (render.yaml: generateValue) and restart.";
  }
  return null;
}

/** Paylet only ever talks to the PayPal sandbox. */
export const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
