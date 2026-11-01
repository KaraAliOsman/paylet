import { z } from "zod";

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
  HASH_SECRET: z.string().min(8).default("paylet-dev-secret"),
  /** Optional owner key that opens every seller console (survives restarts on ephemeral hosting). */
  SELLER_ADMIN_KEY: z.string().min(16).optional(),
});

export const env = schema.parse(process.env);
export type Env = typeof env;

/** Paylet only ever talks to the PayPal sandbox. */
export const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
