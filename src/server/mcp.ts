// Paylet MCP server: lets any AI agent enter a drop on behalf of its person.
// The agent can REQUEST an entry, but it cannot pay: it receives a PayPal approval link for the human.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { db, now } from "./db";
import { HttpError, participantView, publicDrop, startEntry } from "./domain";
import type { DropRow } from "./models";

function buildServer(): McpServer {
  const server = new McpServer({ name: "paylet", version: "0.1.0" });

  server.registerTool(
    "list_drops",
    {
      title: "List open drops",
      description: "List limited drops that are currently open for entries on Paylet (one unit per PayPal account).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // showcase drops first, then recent judge drops (each judge can also pass the slug from their drop page URL)
      const drops = db
        .prepare("SELECT * FROM drops WHERE status = 'open' AND closes_at > ? ORDER BY CASE kind WHEN 'showcase' THEN 0 ELSE 1 END, created_at DESC LIMIT 10")
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
        drop: z.string().max(80).describe("Drop slug from list_drops, or the slug in a drop page URL (/d/<slug>)"),
        agent_name: z.string().max(60).optional().describe("Your agent's display name"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ drop, agent_name }) => {
      try {
        const r = await startEntry(drop, "agent", agent_name ?? "MCP agent");
        const out = {
          entry_ref: r.entryId,
          public_id: r.publicId,
          status: "awaiting_person",
          approve_url: r.approveUrl,
          hold_usd: (r.drop.price_cents + r.drop.ship_hold_cents) / 100,
          message: "Give this PayPal link to your person. Only they can approve the hold. Nothing is charged unless they win.",
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        const code = e instanceof HttpError ? e.code : "paypal_unavailable";
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
          hold_usd: usd(v.holdCents),
          captured_usd: usd(v.capturedCents),
          refunded_usd: usd(v.refundedCents),
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
