// Populates a fresh judge drop on a live instance and captures gallery screenshots (docs/img).
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://paylet.onrender.com";
const out = process.argv[3] ?? "docs/img";
const post = (p: string, key?: string, data?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-seller-key": key } : {}) }, body: JSON.stringify(data ?? {}) }).then((r) => r.json());

const { slug, sellerKey } = await post("/api/judge-drop");
await post(`/api/seller/${slug}/swarm`, sellerKey, { n: 4 });
await post(`/api/seller/${slug}/simulate`, sellerKey);
await new Promise((r) => setTimeout(r, 6000));
await post(`/api/seller/${slug}/analyze`, sellerKey);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const snap = async (name: string, path: string, wait = 2500, full = true) => {
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  console.log("shot", name);
};
await snap("home", "/");
await snap("seller", `/seller/${slug}?k=${sellerKey}`, 3500);
// agent conversation
await page.goto(`${base}/agent?drop=${slug}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Get me into this drop/ }).click();
await page.getByText(/Your agent stopped here/).waitFor({ timeout: 120_000 }).catch(async (e) => { await page.screenshot({ path: "../shots/agent-fail.png", fullPage: true }); throw e; });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/agent.png`, fullPage: true });
console.log("shot agent");
await snap("drop", `/d/${slug}`);
// confirm clusters, draw, verify
const s = await (await fetch(`${base}/api/seller/${slug}`, { headers: { "x-seller-key": sellerKey } })).json();
for (const c of s.clusters) await post(`/api/seller/${slug}/clusters/${c.id}`, sellerKey, { decision: "confirmed" });
await post(`/api/seller/${slug}/draw`, sellerKey);
await new Promise((r) => setTimeout(r, 8000));
await snap("settled", `/seller/${slug}?k=${sellerKey}`, 3000);
await page.goto(`${base}/verify/${slug}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Re-run the draw/ }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/verify.png`, fullPage: true });
console.log("shot verify");
await snap("evals", "/evals");
await snap("how", "/how");
await browser.close();
