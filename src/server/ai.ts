// Thin client for any OpenAI-compatible chat endpoint. Paylet uses Xiaomi MiMo V2.6 Pro (via Primalabs).
// Every call is budgeted (daily cap) and logged (tokens + latency) so the public demo cannot run up a bill.
import { db, now } from "./db";
import { env } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class BudgetExceeded extends Error {}

export function aiConfigured(): boolean {
  return Boolean(env.AI_API_KEY);
}

function callsToday(): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return (db.prepare("SELECT COUNT(*) n FROM llm_usage WHERE ts >= ?").get(start.getTime()) as { n: number }).n;
}

export function usageSummary() {
  const row = db
    .prepare("SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct, COALESCE(AVG(ms),0) ms FROM llm_usage")
    .get() as { calls: number; pt: number; ct: number; ms: number };
  return { ...row, today: callsToday(), dailyCap: env.AI_DAILY_CALL_LIMIT, model: env.AI_MODEL };
}

export async function chat(
  purpose: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; jsonSchema?: { name: string; schema: Record<string, unknown> }; maxTokens?: number; temperature?: number } = {},
): Promise<ChatMessage> {
  if (!aiConfigured()) throw new Error("AI_API_KEY not configured");
  if (callsToday() >= env.AI_DAILY_CALL_LIMIT) throw new BudgetExceeded("daily AI budget reached");
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model: env.AI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.AI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`AI HTTP ${res.status}`);
      const j = (await res.json()) as any;
      if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      db.prepare("INSERT INTO llm_usage(ts, purpose, prompt_tokens, completion_tokens, ms) VALUES(?, ?, ?, ?, ?)").run(
        now(),
        purpose,
        j.usage?.prompt_tokens ?? null,
        j.usage?.completion_tokens ?? null,
        Date.now() - t0,
      );
      return j.choices[0].message as ChatMessage;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Structured output helper: returns the parsed JSON object. */
export async function chatJson<T>(purpose: string, messages: ChatMessage[], name: string, schema: Record<string, unknown>, maxTokens = 2000, temperature = 0.1): Promise<T> {
  const msg = await chat(purpose, messages, { jsonSchema: { name, schema }, maxTokens, temperature });
  const text = (msg.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(text) as T;
}
