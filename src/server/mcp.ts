// Paylet MCP server: lets any AI agent enter a drop on behalf of its person.
// The agent can REQUEST an entry, but it cannot pay: it receives a PayPal approval link for the human.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { APPROVAL_CARD_HTML, APPROVAL_CARD_MIME, APPROVAL_CARD_URI } from "./approval-card";
import { db, now } from "./db";
import { HttpError, participantView, publicDrop, startEntry } from "./domain";
import type { DropRow } from "./models";
import { classify } from "./paypal";

/** PayPal leaves an unapproved order's approval link valid for 3 hours; the drop may close sooner. */
export const APPROVAL_LINK_MS = 3 * 60 * 60_000;

/** A drop slug, or the slug inside a Paylet drop URL (".../d/<slug>"), as fans paste it to their agent. */
export function slugFrom(input: string): string {
  const s = input.trim();
  const m = s.match(/\/d\/([a-z0-9][a-z0-9-]{0,99})(?:[/?#]|$)/i);
  return (m ? m[1] : s).toLowerCase();
}

/** What PayPal holds for an entry, from our ledger (the live answer is GET /api/drops/:slug/paypal-check). */
export function paypalState(status: string, holdCents: number | null, capturedCents: number | null): string | null {
  switch (status) {
    case "held":
    case "waitlist":
    case "won":
      return "CREATED";
    case "captured":
      return capturedCents != null && holdCents != null && capturedCents < holdCents ? "PARTIALLY_CAPTURED" : "CAPTURED";
    case "refunded":
      return "REFUNDED";
    case "lost":
    case "voided":
    case "merged":
    case "capture_failed":
      return holdCents == null ? null : "VOIDED";
    default:
      return null; // no hold exists (awaiting approval, duplicate, expired, error)
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "paylet", version: "1.1.0" });

  // MCP Apps: compatible hosts draw this card under enter_drop; every other host just uses approve_url.
  server.registerResource(
    "approval-card",
    APPROVAL_CARD_URI,
    { title: "PayPal approval card", description: "Shows the person what their agent requested and hands them to PayPal.", mimeType: APPROVAL_CARD_MIME },
    async () => ({ contents: [{ uri: APPROVAL_CARD_URI, mimeType: APPROVAL_CARD_MIME, text: APPROVAL_CARD_HTML, _meta: { ui: { prefersBorder: false } } }] }),
  );

  server.registerTool(
    "list_drops",
    {
      title: "List open drops",
      description:
        "List the public limited drops that are open for entries on Paylet (one unit per PayPal account). Private drops are not listed: if your person gives you a drop link (https://…/d/<slug>), pass it to enter_drop directly.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // public drops only (P0-10): judge drops are private and reachable by their slug / URL, never listed to other agents
      const drops = db
        .prepare("SELECT * FROM drops WHERE status = 'open' AND closes_at > ? AND kind IN ('showcase','proof') ORDER BY created_at DESC LIMIT 10")
        .all(now()) as unknown as DropRow[];
      const list = drops.map((d) => {
        const p = publicDrop(d);
        return { drop: p.slug, title: p.title, maker: p.maker, price_usd: p.priceCents / 100, hold_usd: (p.priceCents + p.shipHoldCents) / 100, units: p.units, closes_at: new Date(p.closesAt).toISOString() };
      });
      return { content: [{ type: "text", text: JSON.stringify({ drops: list }) }], structuredContent: { drops: list } };
    },
  );

  server.registerTool(
    "enter_drop",
    {
      title: "Request an entry for your person",
      description:
        "Request a Paylet entry in a drop for the person you act for. You CANNOT pay or approve: this returns a PayPal approval link that the person must open and approve themselves. Nothing is charged unless they win. One entry per PayPal account — extra entries from the same account place no hold.",
      inputSchema: {
        drop: z.string().max(200).describe("Drop slug from list_drops, or the drop page URL your person gave you (https://…/d/<slug>)"),
        agent_name: z.string().max(60).optional().describe("Your agent's display name"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: APPROVAL_CARD_URI } },
    },
    async ({ drop, agent_name }) => {
      try {
        const r = await startEntry(slugFrom(drop), "agent", agent_name ?? "MCP agent");
        const out = {
          entry_ref: r.entryId,
          public_id: r.publicId,
          title: r.drop.title,
          status: "awaiting_person",
          approve_url: r.approveUrl,
          hold_usd: (r.drop.price_cents + r.drop.ship_hold_cents) / 100,
          // the person must approve before this (PayPal link lifetime or the drop closing, whichever comes first)
          expires_at: new Date(Math.min(Date.now() + APPROVAL_LINK_MS, r.drop.closes_at)).toISOString(),
          message:
            "Give this PayPal link to your person. Only they can approve the hold, and the entry only counts once they do. PayPal places the hold when they approve; they are only charged if they win.",
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        const code = e instanceof HttpError ? e.code : classify(e).status === 429 ? "rate_limited" : "paypal_unavailable";
        return { isError: true, content: [{ type: "text", text: `enter_drop failed: ${code}` }] };
      }
    },
  );

  server.registerTool(
    "entry_status",
    {
      title: "Check an entry",
      description:
        "Check the status of an entry you requested: awaiting_person, held, duplicate, won, captured, shipped (captured and on its way, with tracking), refunded, voided…",
      inputSchema: { entry_ref: z.string().max(80) },
      annotations: { readOnlyHint: true },
    },
    async ({ entry_ref }) => {
      try {
        const v = participantView(entry_ref);
        const usd = (cents: number | null) => (cents == null ? null : cents / 100);
        const out = {
          entry_ref,
          public_id: v.publicId,
          // "shipped" is a captured entry the maker has handed to a carrier (tracking is also in the person's PayPal account)
          status: v.status === "captured" && v.shipping ? "shipped" : v.status,
          note: v.note,
          explanation: v.explanation,
          drop: v.drop.slug,
          title: v.drop.title,
          drop_status: v.drop.status,
          draw_at: new Date(v.drop.closesAt).toISOString(),
          hold_usd: usd(v.holdCents),
          captured_usd: usd(v.capturedCents),
          refunded_usd: usd(v.refundedCents),
          // what PayPal holds per our ledger: CREATED (hold alive), PARTIALLY_CAPTURED / CAPTURED, VOIDED, REFUNDED, or null (no hold)
          paypal_state: paypalState(v.status, v.holdCents, v.capturedCents),
          shipping: v.shipping,
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch {
        return { isError: true, content: [{ type: "text", text: "entry_not_found" }] };
      }
    },
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(req: Request, parsedBody?: unknown): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return parsedBody === undefined ? transport.handleRequest(req) : transport.handleRequest(req, { parsedBody });
}
