// REAL end-to-end (no mocks): agent link → PayPal sandbox approval → /return → hold placed.
import { chromium } from "@playwright/test";
import { approveInPayPal } from "./paypal-approve";

const base = process.env.E2E_BASE_URL ?? "https://paylet.onrender.com";
const shots = process.argv[2] ?? "../shots/pp";
const { slug, sellerKey } = await (await fetch(`${base}/api/judge-drop`, { method: "POST" })).json();
console.log("judge drop", slug);
const mcp = await (await fetch(`${base}/api/agent/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: `Please enter me in the Paylet drop with slug "${slug}".` }] }) })).json();
console.log("agent approveUrl:", Boolean(mcp.approveUrl), "entry", mcp.entryRef);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(mcp.approveUrl);
await approveInPayPal(page, { email: process.env.BUYER_EMAIL!, password: process.env.BUYER_PASSWORD!, shots, log: (m) => console.log("  pp:", m) });
await page.waitForURL(/\/(return|me)\b/, { timeout: 90_000 });
console.log("back at", new URL(page.url()).pathname);
await page.waitForURL(/\/me\//, { timeout: 60_000 });
await page.getByText(/Hold placed|Placing hold/).first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${shots}/04-me.png`, fullPage: true });
const entry = await (await fetch(`${base}/api/entries/${mcp.entryRef}`)).json();
console.log("entry status:", entry.status, "hold:", entry.holdCents);
const seller = await (await fetch(`${base}/api/seller/${slug}`, { headers: { "x-seller-key": sellerKey } })).json();
console.log("seller stats:", JSON.stringify(seller.drop.stats));
await browser.close();
console.log(JSON.stringify({ slug, sellerKey, entryRef: mcp.entryRef }));
