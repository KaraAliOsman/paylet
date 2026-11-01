// Dev helper: screenshots of every page (desktop + phone) for a visual review. Not part of the app.
import { chromium } from "@playwright/test";
const base = process.argv[2] ?? "http://localhost:8790";
const out = process.argv[3] ?? "../shots/rev";
const only = process.argv[4]?.split(",");
const post = (p: string, key?: string, data?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-seller-key": key } : {}) }, body: JSON.stringify(data ?? {}) }).then((r) => r.json());
const jd = await post("/api/judge-drop");
const { slug, sellerKey } = jd;
const proof = (await (await fetch(base + "/api/proof").catch(() => null))?.json().catch(() => null)) ?? {};
const proofSlug = proof?.slug ?? proof?.drop?.slug ?? "ember-glaze-mug-2710";
const pages: [string, string][] = [
  ["home", "/"], ["judge", "/judge"], ["how", "/how"], ["drop", `/d/${slug}`], ["seller", `/seller/${slug}?k=${sellerKey}`],
  ["agent", `/agent?drop=${slug}`], ["verify-proof", `/verify/${proofSlug}`], ["proof-drop", `/d/${proofSlug}`], ["404", "/nope"],
];
const browser = await chromium.launch();
for (const [vw, vh, tag] of [[1360, 900, "d"], [390, 844, "m"]] as const) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("PAGEERROR", tag, e.message));
  for (const [name, path] of pages) {
    if (only && !only.includes(name)) continue;
    await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-${tag}.png`, fullPage: true });
    console.log("shot", name, tag);
  }
  await page.close();
}
await browser.close();
console.log(JSON.stringify({ slug, sellerKey, proofSlug }));
