// Captures screenshots of the main pages (used for the README / Devpost gallery).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8790";
const out = process.argv[3] ?? "../shots";
const sellerLink = readFileSync("data/showcase-seller-link.txt", "utf8").trim().replace(/^https?:\/\/[^/]+/, "");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const drops = await (await fetch(`${base}/api/drops`)).json();
const slug = drops.open[0].slug;
const shots: [string, string][] = [
  ["home", "/"],
  ["drop", `/d/${slug}`],
  ["seller", sellerLink],
  ["agent", "/agent"],
  ["evals", "/evals"],
  ["judge", "/judge"],
  ["how", "/how"],
];
for (const [name, path] of shots) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log("shot", name);
}
await browser.close();
