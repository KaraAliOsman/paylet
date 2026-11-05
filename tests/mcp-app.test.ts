// The MCP App card, spoken to the way a host does: tools/list, resources/read and a tool call, through a real MCP client.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pp } from "./helpers/fakePaypal";

vi.mock("../src/server/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/paypal")>()),
  ...(await import("./helpers/fakePaypal")).fakeApi,
}));

let app: typeof import("../src/server/index")["app"];
let domain: typeof import("../src/server/domain");
let client: Client;

beforeAll(async () => {
  app = (await import("../src/server/index")).app;
  domain = await import("../src/server/domain");
  client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch: async (url, init) => app.request(String(url), init) }));
});

describe("Paylet MCP App", () => {
  it("enter_drop points at the approval card; the other tools stay plain", async () => {
    const { tools } = await client.listTools();
    const enter = tools.find((t) => t.name === "enter_drop")!;
    expect(enter._meta).toMatchObject({ ui: { resourceUri: "ui://paylet/approval-card" } });
    expect(tools.find((t) => t.name === "list_drops")!._meta?.ui).toBeUndefined();
  });

  it("the card is served with the MCP Apps media type and needs no network", async () => {
    const r = await client.readResource({ uri: "ui://paylet/approval-card" });
    const c = r.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain("ui/initialize");
    expect(c.text).not.toMatch(/\b(src|href)="https?:/); // no external scripts, styles or images
    expect(c.text).not.toMatch(/innerHTML/);
  });

  it("the tool result still carries a plain link, for every host without MCP Apps", async () => {
    const drop = await domain.createDrop({ ...domain.SHOWCASE, units: 1 });
    const r = (await client.callTool({ name: "enter_drop", arguments: { drop: drop.slug, agent_name: "host" } })) as unknown as { structuredContent: { approve_url: string; entry_ref: string; hold_usd: number } };
    expect(r.structuredContent.approve_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(r.structuredContent.hold_usd).toBe(77);
    expect(pp.calls.some((c) => c.startsWith("create "))).toBe(true);
    expect(pp.calls.some((c) => c.startsWith("authorize "))).toBe(false); // an agent never gets past this point
  });
});
