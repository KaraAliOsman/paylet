// A fan's personal shopping agent (MiMo V2.6 Pro) that talks to Paylet through the same Streamable HTTP MCP endpoint any
// client uses (over loopback, with an internal token that only skips the rate limiter). It can request an entry; it
// cannot approve or pay. Its replies are post-filtered so they never claim more than the ledger says.
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { chat, type ChatMessage, type ToolDef } from "./ai";
import { env } from "./env";
import { emit, getDrop } from "./models";
import { formatUsd } from "../shared/money";

// ---------------------------------------------------------------- loopback MCP client (internal token)

export const INTERNAL_HEADER = "x-paylet-internal";

/** HMAC_SHA256(HASH_SECRET, "mcp-internal"): marks Paylet's own agents. It only selects a separate rate-limit bucket. */
export function internalToken(): string {
  return createHmac("sha256", env.HASH_SECRET).update("mcp-internal").digest("hex");
}

let mcpFetch: FetchLike | undefined;
/** Test hook: route the loopback MCP client through `app.request` instead of the network. */
export function _setMcpFetch(f: FetchLike | undefined): void {
  mcpFetch = f;
}

function mcpUrl(): URL {
  return new URL(`http://127.0.0.1:${env.PORT}/mcp`);
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: "0.2.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(), { requestInit: { headers: { [INTERNAL_HEADER]: internalToken() } }, fetch: mcpFetch }));
  return client;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const textOf = (res: unknown) => (((res as { content?: unknown }).content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");

// ---------------------------------------------------------------- Wren

export const SYSTEM = `You are "Wren", a personal shopping assistant for one person. You can use the Paylet tools (via MCP) to find limited drops and request an entry for your person.
Rules you must follow:
- You can request an entry, but you can NEVER approve or pay. Paylet gives you a PayPal approval link; the app shows your person the PayPal button. Then stop.
- Never create more than one entry per drop for your person.
- If your person gives you a drop link (…/d/<slug>), call enter_drop with that link. Private drops are not in list_drops.
- Never say the person is "in", "entered" or "all set". Say: "I've requested your entry. It only counts once you approve the hold in PayPal."
- Describe money exactly like this: "PayPal places a $X hold when you approve. You're only charged if you win (price + actual shipping); if you don't, the hold is voided."
- Never paste URLs; the app shows the PayPal button. No emojis. No markdown links.
- Be brief and warm: two or three short sentences, plain text.`;

export const HONEST_ENTRY = "I've requested your entry. It only counts once you approve the hold in PayPal.";
export const AI_OFFLINE_NOTE = "(My language model didn't answer in time, so I used my fixed rules for this one.)";

/** Wren answers within this budget; past it, a pasted drop link is entered deterministically over MCP. */
export const AGENT_DEADLINE_MS = 35_000;

/** A drop slug in a message: a pasted drop link (…/d/<slug>) or a bare slug like "ember-glaze-mug-8f3a". */
export function slugIn(text: string): string | null {
  const m = text.match(/\/d\/([a-z0-9]+(?:-[a-z0-9]+)*)/i) ?? text.match(/\b([a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4,8})\b/i);
  return m ? m[1].toLowerCase() : null;
}

export const AGENT_ERROR_REPLY = "I couldn't reach Paylet just now. Nothing was requested or charged. Try again.";

/** Statuses in which a hold really exists for the person (only then may Wren say they are in the ballot). */
const HOLD_STATUSES = new Set(["held", "waitlist", "won", "captured", "shipped"]);

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Post-filter for every Wren reply: no markdown links, no URLs, no markdown decoration, no emojis, and never
 *  "you're in" unless a hold exists. */
export function cleanReply(raw: string, opts: { holdConfirmed?: boolean } = {}): string {
  let s = raw
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1") // [text](url) → text
    .replace(/<https?:\/\/[^>\s]+>/gi, "")
    .replace(/\bhttps?:\/\/[^\s)\]]+/gi, "")
    .replace(/\bwww\.[^\s)\]]+/gi, "")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.paypal\.com\S*/gi, "")
    .replace(EMOJI, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+(?:or|and|at|via)[ \t]*$/gim, "") // "here: <link> or <link>" leaves a dangling connector
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/:\s*$/gm, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // "only placed if you win" is false: the hold is placed on approval, the CHARGE only happens if they win
  // (a sentence fragment may contain "$77.00": a dot followed by a digit is not a sentence end)
  s = s.replace(/(?:[^.!?\n]|\.(?=\d))*\bonly (?:be )?placed if you win(?:[^.!?\n]|\.(?=\d))*[.!?]?/gi, "PayPal places the hold when you approve; you're only charged if you win.");
  if (!opts.holdConfirmed && /\byou(?:['’]re| are) (?:in|all set|entered)\b/i.test(s)) s = HONEST_ENTRY;
  return s;
}

export interface AgentTraceItem {
  tool: string;
  summary: string;
  raw: { args: unknown; result: unknown };
}

export interface AgentHandoff {
  entryRef: string;
  publicId: string;
  title: string;
  holdCents: number;
  approveUrl: string;
  expiresAt: number;
}

export interface AgentTurn {
  reply: string;
  trace: AgentTraceItem[];
  handoff: AgentHandoff | null;
  error?: true;
  /** @deprecated v1 shape (kept for older clients and the real e2e suite): use handoff */
  approveUrl?: string;
  /** @deprecated v1 shape: use handoff.entryRef */
  entryRef?: string;
}

function summarize(tool: string, args: Record<string, unknown>, structured: Record<string, any> | null, text: string, isError: boolean): string {
  const arg = tool === "enter_drop" ? String(args.drop ?? "").replace(/^.*\/d\//, "") : tool === "entry_status" ? String(structured?.public_id ?? args.entry_ref ?? "") : "";
  const call = arg ? `${tool}(${arg.slice(0, 60)})` : tool;
  if (isError) return `${call} → error: ${text.replace(/^[a-z_]+ failed: /, "").slice(0, 60)}`;
  if (tool === "list_drops") {
    const n = Array.isArray(structured?.drops) ? structured!.drops.length : 0;
    return `${call} → ${n} drop${n === 1 ? "" : "s"}`;
  }
  return `${call} → ${structured?.status ?? "ok"}`;
}

/** Deterministic first line once enter_drop returned structured data (the model never phrases the money part). */
export function requestedLine(h: AgentHandoff): string {
  return `Requested entry ${h.publicId} in "${h.title}". It only counts once you approve the ${formatUsd(h.holdCents)} hold in PayPal; you're only charged if you win.`;
}

/** After a handoff the deterministic line already covers the request, the hold and the money: keep only the model
 *  sentences that add something else (an answer to another question, a drop tip), so Wren never says it three times. */
export function extraSentences(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  return sentences
    .filter((x) => x.trim() && !/\b(hold|approv\w*|charg\w*|request\w*|entry|entries|void\w*|win|PayPal)\b/i.test(x))
    .join(" ")
    .trim();
}

export async function runFanAgent(history: { role: "user" | "assistant"; content: string }[]): Promise<AgentTurn> {
  const trace: AgentTraceItem[] = [];
  let handoff: AgentHandoff | null = null;
  let holdConfirmed = false;
  const finish = (modelText: string): AgentTurn => {
    let reply = cleanReply(modelText, { holdConfirmed });
    if (handoff) {
      const first = requestedLine(handoff);
      // the model's own words follow only where they add something the deterministic line doesn't already say
      const extra = reply && !reply.includes(handoff.publicId) ? extraSentences(reply) : "";
      reply = extra ? `${first}\n\n${extra}` : first;
    }
    if (!reply) reply = "I can find open drops or request an entry for you. Paste a drop link, or ask what's open.";
    return { reply, trace, handoff, ...(handoff ? { approveUrl: handoff.approveUrl, entryRef: handoff.entryRef } : {}) };
  };
  let client: Client | null = null;
  try {
    client = await connect("wren-fan-agent");
    const { tools } = await client.listTools();
    const toolDefs: ToolDef[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> },
    }));
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...history.slice(-8)];
    let entered = false;
    const deadline = Date.now() + AGENT_DEADLINE_MS;
    for (let step = 0; step < 4; step++) {
      const left = deadline - Date.now();
      if (left < 2_000) throw new Error("AI deadline reached");
      const msg = await chat("fan_agent", messages, { tools: toolDefs, maxTokens: 700, temperature: 0.3, timeoutMs: Math.min(25_000, left), attempts: 1 });
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      if (!msg.tool_calls?.length) return finish(msg.content ?? "");
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* ignore */
        }
        if (call.function.name === "enter_drop") {
          if (entered) {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "already requested one entry this turn" }) });
            continue;
          }
          entered = true;
          args.agent_name = "Wren (fan's assistant)";
        }
        const res = await client.callTool({ name: call.function.name, arguments: args });
        const structured = (res.structuredContent ?? null) as Record<string, any> | null;
        const text = textOf(res);
        trace.push({ tool: call.function.name, summary: summarize(call.function.name, args, structured, text, Boolean(res.isError)), raw: { args, result: structured ?? text } });
        if (call.function.name === "enter_drop" && structured?.approve_url) {
          handoff = {
            entryRef: String(structured.entry_ref),
            publicId: String(structured.public_id),
            title: String(structured.title ?? ""),
            holdCents: Math.round(Number(structured.hold_usd) * 100),
            approveUrl: String(structured.approve_url),
            expiresAt: Date.parse(String(structured.expires_at)) || Date.now() + 3 * 60 * 60_000,
          };
        }
        if (call.function.name === "entry_status" && HOLD_STATUSES.has(String(structured?.status))) holdConfirmed = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: text || JSON.stringify(structured) });
      }
    }
    if (handoff) return finish("");
    return { reply: "I couldn't finish that. Nothing was requested or charged. Try again.", trace, handoff: null, error: true };
  } catch (e) {
    console.warn("[wren]", String(e).slice(0, 200));
    // an entry was already requested: say exactly that (it exists), never "nothing was requested"
    if (handoff) return finish("");
    // The model is unreachable (provider outage or budget) but the person pasted a drop link: Wren's one job needs no
    // reasoning, so it requests the entry over the same MCP tool, deterministically, and says it ran without the model.
    const slug = client && /^AI /.test(String((e as Error)?.message ?? "")) ? slugIn(history.filter((m) => m.role === "user").at(-1)?.content ?? "") : null;
    if (client && slug) {
      try {
        const args = { drop: slug, agent_name: "Wren (fan's assistant)" };
        const res = await client.callTool({ name: "enter_drop", arguments: args });
        const structured = (res.structuredContent ?? null) as Record<string, any> | null;
        trace.push({ tool: "enter_drop", summary: summarize("enter_drop", args, structured, textOf(res), Boolean(res.isError)), raw: { args, result: structured ?? textOf(res) } });
        if (structured?.approve_url) {
          handoff = {
            entryRef: String(structured.entry_ref),
            publicId: String(structured.public_id),
            title: String(structured.title ?? ""),
            holdCents: Math.round(Number(structured.hold_usd) * 100),
            approveUrl: String(structured.approve_url),
            expiresAt: Date.parse(String(structured.expires_at)) || Date.now() + 3 * 60 * 60_000,
          };
          const t = finish("");
          return { ...t, reply: `${t.reply}\n\n${AI_OFFLINE_NOTE}` };
        }
      } catch (e2) {
        console.warn("[wren] direct entry failed", String(e2).slice(0, 200));
      }
    }
    return { reply: AGENT_ERROR_REPLY, trace, handoff: null, error: true };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- "Ask Wren how it went" (P2-02), deterministic

export interface EntryStatusOut {
  public_id: string;
  status: string;
  title?: string;
  drop_status?: string;
  draw_at?: string;
  hold_usd: number | null;
  captured_usd: number | null;
  refunded_usd: number | null;
  paypal_state?: string | null;
  shipping?: { carrier: string; tracking: string } | null;
}

const usd = (v: number | null | undefined) => formatUsd(Math.round((v ?? 0) * 100));

/** The answer is built from entry_status alone: no model wording, so it can never contradict the ledger. */
export function describeOutcome(s: EntryStatusOut, nowMs = Date.now()): string {
  const hold = s.hold_usd != null ? usd(s.hold_usd) : "";
  const released = s.hold_usd != null && s.captured_usd != null ? Math.max(0, Math.round(s.hold_usd * 100) - Math.round(s.captured_usd * 100)) : 0;
  const capturedLine = `You got one. PayPal captured ${usd(s.captured_usd)}${released ? ` and released ${formatUsd(released)} of your hold` : ""}.`;
  switch (s.status) {
    case "captured":
      return capturedLine;
    case "shipped":
      return `${capturedLine} It's on its way: ${s.shipping?.carrier ?? "carrier"} tracking ending ${String(s.shipping?.tracking ?? "").slice(-4)} (also in your PayPal account).`;
    case "refunded":
      return `You got one, then the maker refunded ${usd(s.refunded_usd ?? s.captured_usd)} through PayPal. You owe nothing.`;
    case "won":
      return "You were drawn. PayPal is capturing the payment now.";
    case "lost":
      return `Not selected. PayPal is voiding your ${hold} hold now. Charged: $0.`;
    case "voided":
      return `Not selected. PayPal voided your ${hold} hold. Charged: $0.`;
    case "merged":
      return `The seller grouped your PayPal account with others at the same address, so the group shared one ticket. PayPal voided your ${hold} hold. Charged: $0.`;
    case "capture_failed":
      return "You were drawn, but the payment didn't go through, so the unit passed to the next person on the waitlist. Your hold was voided. Charged: $0.";
    case "waitlist":
      return `You're on the waitlist. Your ${hold} hold stays in place until the winners pay; if a payment fails, the unit comes to you.`;
    case "held": {
      if (s.drop_status === "frozen") return `The list is frozen and your ${hold} hold is in it. The winners come from public randomness in a few seconds.`;
      const mins = s.draw_at ? Math.max(0, Math.round((Date.parse(s.draw_at) - nowMs) / 60_000)) : null;
      return `No draw yet. Your ${hold} hold is in place${mins != null ? `; the draw is in ${mins <= 1 ? "about a minute" : `${mins} minutes`}` : ""}. You're only charged if you win.`;
    }
    case "authorizing":
      return "You approved it. PayPal is placing your hold right now.";
    case "awaiting_person":
      return "You haven't approved the hold in PayPal yet, so the entry doesn't count. Approve it before the drop closes.";
    case "duplicate":
      return "That PayPal account already had an entry in this drop, so no second hold was placed. Charged: $0.";
    case "expired":
      return "Nobody approved the hold in PayPal before the drop closed, so there was no entry. Charged: $0.";
    case "error":
      return "PayPal couldn't place the hold, so there was no entry. Charged: $0.";
    default:
      return `Your entry is ${s.status.replace(/_/g, " ")}.`;
  }
}

/** Wren asks Paylet's MCP entry_status (same loopback client) and answers from the structured result. */
export async function howItWent(entryRef: string, direct: (ref: string) => EntryStatusOut | null): Promise<{ reply: string; status: string; trace: AgentTraceItem[] } | null> {
  let s: EntryStatusOut | null = null;
  const trace: AgentTraceItem[] = [];
  let client: Client | null = null;
  try {
    client = await connect("wren-how-it-went");
    const res = await client.callTool({ name: "entry_status", arguments: { entry_ref: entryRef } });
    if (!res.isError) s = res.structuredContent as unknown as EntryStatusOut;
    trace.push({ tool: "entry_status", summary: summarize("entry_status", { entry_ref: entryRef }, (s as Record<string, any> | null) ?? null, textOf(res), Boolean(res.isError)), raw: { args: { entry_ref: entryRef }, result: s ?? textOf(res) } });
  } catch {
    s = direct(entryRef); // loopback unavailable: the same data, read in-process
  } finally {
    await client?.close().catch(() => undefined);
  }
  if (!s) return null;
  return { reply: describeOutcome(s), status: s.status, trace };
}

// ---------------------------------------------------------------- scalper swarm (P0-02: resilient, always reports)

export interface SwarmOptions {
  /** pause between agents (stays well under the sandbox rate limit) */
  delayMs?: number;
  /** backoff before each retry of a rate-limited call */
  backoffMs?: number[];
}

export interface SwarmResult {
  requested: number;
  links: string[];
  rateLimited: number;
  closed: number;
  failed: number;
}

const isRateLimited = (e: unknown) => (e as { code?: unknown })?.code === 429 || /rate[_ ]limited|\b429\b/i.test(String((e as Error)?.message ?? e));

/** The exact ledger copy (P0-02). */
export function swarmDoneMessage(r: SwarmResult): string {
  const n = r.requested;
  const errors = r.rateLimited + r.closed + r.failed;
  if (!errors) {
    return `${n} scalper agent${n === 1 ? "" : "s"} → ${r.links.length} PayPal approval link${r.links.length === 1 ? "" : "s"} · 0 holds. A hold needs a person to approve in PayPal, and only one per PayPal account counts.`;
  }
  const why = [
    r.rateLimited ? `${r.rateLimited} ${r.rateLimited === 1 ? "was" : "were"} rate-limited` : "",
    r.closed ? `${r.closed} found the drop closed` : "",
    r.failed ? `${r.failed} hit an error` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${r.links.length} of ${n} agents got a PayPal link (${why}) · 0 holds.`;
}

/** A scalper fires N agents at one drop through MCP. Each gets an approval link; none can place a hold without a person.
 *  Every call is retried (1, 2, 4 s) when rate-limited, and the ledger ALWAYS gets the swarm_done line. */
export async function runSwarm(dropSlug: string, n: number, opts: SwarmOptions = {}): Promise<SwarmResult> {
  const drop = getDrop(dropSlug);
  if (!drop) throw new Error("drop_not_found");
  const delay = opts.delayMs ?? 900;
  const backoff = opts.backoffMs ?? [1_000, 2_000, 4_000];
  emit(drop.id, "swarm_start", `Scalper swarm: ${n} agents hitting the drop through MCP…`, false);
  const r: SwarmResult = { requested: n, links: [], rateLimited: 0, closed: 0, failed: 0 };
  let client: Client | null = null;
  try {
    for (let i = 0; i < n; i++) {
      let outcome: "link" | "rate_limited" | "closed" | "failed" = "failed";
      for (let attempt = 0; attempt <= backoff.length; attempt++) {
        try {
          client ??= await connect("scalper-swarm");
          const res = await client.callTool({ name: "enter_drop", arguments: { drop: drop.slug, agent_name: `scalper-bot-${String(i + 1).padStart(2, "0")}` } });
          const s = res.structuredContent as { approve_url?: string } | undefined;
          if (s?.approve_url) {
            r.links.push(s.approve_url);
            outcome = "link";
          } else {
            const text = textOf(res);
            outcome = /rate_limited/.test(text) ? "rate_limited" : /drop_closed|drop_not_found/.test(text) ? "closed" : "failed";
          }
        } catch (e) {
          outcome = isRateLimited(e) ? "rate_limited" : "failed";
          if (outcome === "failed") {
            await client?.close().catch(() => undefined);
            client = null; // reconnect on the next try
          }
        }
        if (outcome === "link" || outcome === "closed" || attempt === backoff.length) break;
        await sleep(backoff[attempt]);
      }
      if (outcome === "rate_limited") r.rateLimited++;
      else if (outcome === "closed") r.closed++;
      else if (outcome === "failed") r.failed++;
      if (outcome === "closed") {
        r.closed += n - i - 1; // the drop closed: the remaining agents would all bounce
        break;
      }
      if (i < n - 1) await sleep(delay);
    }
  } finally {
    await client?.close().catch(() => undefined);
    // anything not accounted for (an unexpected throw) is reported as an error, never as a link
    r.failed += Math.max(0, n - r.links.length - r.rateLimited - r.closed - r.failed);
    const errors = r.rateLimited + r.closed + r.failed;
    emit(drop.id, "swarm_done", swarmDoneMessage(r), false, errors ? { tone: "warn", links: r.links.length, errors } : { links: r.links.length });
  }
  return r;
}
