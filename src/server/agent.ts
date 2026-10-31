// A fan's personal shopping agent (MiMo V2.6 Pro) that talks to Paylet ONLY through the public MCP endpoint —
// exactly like a third-party assistant would. It can request an entry; it cannot approve or pay.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chat, type ChatMessage, type ToolDef } from "./ai";
import { env } from "./env";
import { emit, getDrop } from "./models";

function mcpUrl(): URL {
  return new URL(`http://127.0.0.1:${env.PORT}/mcp`);
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl()));
  return client;
}

const SYSTEM = `You are "Wren", a personal shopping assistant for one person. You can use the Paylet tools (via MCP) to find limited drops and request an entry for your person.
Rules you must follow:
- You can request an entry, but you can NEVER approve or pay. Paylet gives you a PayPal approval link; hand it to your person and stop.
- Never create more than one entry per drop for your person.
- Be brief and warm. When you get an approve_url, tell the person the hold amount, that nothing is charged unless they win, and that they must approve it themselves.`;

export interface AgentTurn {
  reply: string;
  trace: { tool: string; args: unknown; result: unknown }[];
  approveUrl?: string;
  entryRef?: string;
}

export async function runFanAgent(history: { role: "user" | "assistant"; content: string }[]): Promise<AgentTurn> {
  const client = await connect("wren-fan-agent");
  try {
    const { tools } = await client.listTools();
    const toolDefs: ToolDef[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> },
    }));
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...history.slice(-8)];
    const trace: AgentTurn["trace"] = [];
    let approveUrl: string | undefined;
    let entryRef: string | undefined;
    let entered = false;

    for (let step = 0; step < 4; step++) {
      const msg = await chat("fan_agent", messages, { tools: toolDefs, maxTokens: 700, temperature: 0.3 });
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      if (!msg.tool_calls?.length) {
        return { reply: msg.content ?? "", trace, approveUrl, entryRef };
      }
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
        const text = (res.content as { type: string; text?: string }[] | undefined)?.map((c) => c.text ?? "").join("\n") ?? "";
        trace.push({ tool: call.function.name, args, result: structured ?? text });
        if (structured?.approve_url) {
          approveUrl = structured.approve_url;
          entryRef = structured.entry_ref;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: text || JSON.stringify(structured) });
      }
    }
    return { reply: "I've requested your entry — please approve the PayPal hold with the button below.", trace, approveUrl, entryRef };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A scalper fires N agents at one drop. Each gets an approval link; none can place a hold without a person. */
export async function runSwarm(dropSlug: string, n: number): Promise<{ requested: number; links: string[] }> {
  const drop = getDrop(dropSlug);
  if (!drop) throw new Error("drop_not_found");
  emit(drop.id, "swarm_start", `Scalper swarm: ${n} agents hitting the drop through MCP…`, false);
  const client = await connect("scalper-swarm");
  const links: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const res = await client.callTool({ name: "enter_drop", arguments: { drop: drop.slug, agent_name: `scalper-bot-${String(i + 1).padStart(2, "0")}` } });
      const s = res.structuredContent as { approve_url?: string } | undefined;
      if (s?.approve_url) links.push(s.approve_url);
      await new Promise((r) => setTimeout(r, 900)); // stay well under the sandbox rate limit
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  emit(drop.id, "swarm_done", `Scalper swarm finished: ${links.length} approval links issued, 0 holds — every hold still needs a person to approve in PayPal, and only one per PayPal account counts.`, false);
  return { requested: n, links };
}
