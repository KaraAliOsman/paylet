// Smoke test for the public MCP endpoint: list tools, list drops, request an entry, check it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:8790/mcp";
const c = new Client({ name: "paylet-smoke", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const t = await c.listTools();
console.log("tools:", t.tools.map((x) => x.name).join(", "));
const l = await c.callTool({ name: "list_drops", arguments: {} });
const drops = (l.structuredContent as { drops: { drop: string }[] }).drops;
console.log("open drops:", drops.map((d) => d.drop).join(", "));
const e = await c.callTool({ name: "enter_drop", arguments: { drop: drops[0].drop, agent_name: "smoke-test-agent" } });
const s = e.structuredContent as { status: string; public_id: string; approve_url?: string; entry_ref: string };
console.log("enter_drop:", s.status, s.public_id, s.approve_url ? "approve_url ✓" : "no approve_url");
const st = await c.callTool({ name: "entry_status", arguments: { entry_ref: s.entry_ref } });
console.log("entry_status:", JSON.stringify(st.structuredContent));
await c.close();
