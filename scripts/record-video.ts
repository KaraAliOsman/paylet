// Records the demo-video scenes (entrega/VIDEO.md storyboard) against a live instance, one clip per scene, in native 1080p:
// a 1920×1080 viewport with the page zoomed 1.5× (so the layout is the 1280-wide one, rendered sharp). A drawn cursor glides
// to every click. Each scene also writes <scene>.marks.json (seconds since the clip started) so scripts/edit-video.mjs can
// cut the waiting and place the voice-over on the action. Page content only: no address bar, so seller keys never show, and
// the sandbox buyer's email is blurred inside PayPal. Needs BUYER_EMAIL / BUYER_PASSWORD (sandbox) and SELLER_ADMIN_KEY.
//   node --env-file=../.secrets/buyer.env --env-file=../.secrets/seller_admin.env --import tsx scripts/record-video.ts [base] [outDir] [scenes]
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { approveInPayPal } from "./paypal-approve";

const base = process.argv[2] ?? "https://paylet.onrender.com";
const out = process.argv[3] ?? "../entrega/video";
const only = process.argv[4]?.split(",");
const BUYER = { email: process.env.BUYER_EMAIL ?? "", password: process.env.BUYER_PASSWORD ?? "" };
const ADMIN = process.env.SELLER_ADMIN_KEY ?? "";
const W = 1920;
const H = 1080;
mkdirSync(`${out}/raw`, { recursive: true });

const post = (p: string, key?: string, data?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-seller-key": key } : {}) }, body: JSON.stringify(data ?? {}) }).then((r) => r.json());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs in every page: 1.5× zoom, a drawn cursor with a click ripple, and the PayPal login identity blurred.
 * A string, not a function: tsx would wrap nested functions in __name(), which does not exist in the page. */
const PAGE_SETUP = `(() => {
  const onPayPal = /paypal\.com$/.test(location.hostname);
  const setup = () => {
    document.documentElement.style.zoom = onPayPal ? "1.35" : "1.5";
    const s = document.createElement("style");
    s.textContent = \`
      html{scrollbar-width:none}html::-webkit-scrollbar{display:none}
      #__cur{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;transform:translate(-200px,-200px)}
      #__cur svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
      .__rip{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        background:rgba(20,20,20,.18);animation:__rip .5s cubic-bezier(.23,1,.32,1) forwards}
      @keyframes __rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      \${onPayPal ? "#email,input[name=login_email],#password,[data-testid=header-profile],.profileDisplayName,.email{filter:blur(7px)!important}" : ""}\`;
    (document.head ?? document.documentElement).appendChild(s);
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML =
      '<svg width="20" height="24" viewBox="0 0 20 24"><path d="M2 1.5v18.2l5-4.6 3.3 7.4 3-1.3-3.2-7.3H17z" fill="#141414" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const last = sessionStorage.getItem("__cur");
    if (last) c.style.transform = last;
    document.addEventListener(
      "mousemove",
      (e) => {
        const z = parseFloat(document.documentElement.style.zoom) || 1;
        const t = \`translate(\${e.clientX / z - 2}px, \${e.clientY / z - 1}px)\`;
        c.style.transform = t;
        sessionStorage.setItem("__cur", t);
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (e) => {
        const r = document.createElement("div");
        r.className = "__rip";
        const z = parseFloat(document.documentElement.style.zoom) || 1;
        r.style.left = \`\${e.clientX / z}px\`;
        r.style.top = \`\${e.clientY / z}px\`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 600);
      },
      true,
    );
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();`;

let marks: [string, number][] = [];
let t0 = 0;
const mark = (name: string) => marks.push([name, +((Date.now() - t0) / 1000).toFixed(2)]);

async function scene(browser: Browser, name: string, run: (page: Page, ctx: BrowserContext) => Promise<void>) {
  if (only && !only.includes(name.slice(0, 2))) return;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: `${out}/raw`, size: { width: W, height: H } }, locale: "en-US" });
  await ctx.addInitScript({ content: PAGE_SETUP });
  const page = await ctx.newPage();
  t0 = Date.now();
  marks = [];
  try {
    await run(page, ctx);
  } catch (e) {
    console.log(`scene ${name} FAILED:`, (e as Error).message.split("\n")[0]);
    await page.screenshot({ path: `${out}/raw/${name}-fail.png` }).catch(() => undefined);
  }
  mark("end");
  const video = page.video();
  await ctx.close();
  if (video) renameSync(await video.path(), `${out}/raw/${name}.webm`);
  writeFileSync(`${out}/raw/${name}.marks.json`, JSON.stringify(Object.fromEntries(marks), null, 1));
  console.log(`scene ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(marks));
}

/** Glide the cursor to the element (ease-out), pause, click. */
async function glideTo(page: Page, target: Locator, click = true) {
  // no scrollIntoViewIfNeeded: it waits for the element to stop moving, and the hero card floats forever
  await target.waitFor({ state: "visible" });
  let box = await target.boundingBox();
  if (!box) throw new Error("no box");
  if (box.y < 70 || box.y + box.height > H - 20) {
    await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await wait(150);
    box = (await target.boundingBox())!;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 28 });
  await wait(220);
  if (click) {
    await page.mouse.down();
    await wait(70);
    await page.mouse.up();
  }
}

/** Smooth scroll by `px` (viewport px) over `ms`, eased, animated inside the page (one round trip, no dropped steps). */
async function glide(page: Page, px: number, ms: number) {
  await page.evaluate(
    `new Promise((done) => {
      const z = parseFloat(document.documentElement.style.zoom) || 1;
      const from = window.scrollY, by = ${px} / z, t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ${ms});
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        window.scrollTo(0, from + by * e);
        if (k < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    })`,
  );
}

async function open(page: Page, path: string, settle = 1200) {
  await page.goto(base + path, { waitUntil: "load" }).catch(() => undefined);
  await page.evaluate("document.fonts.ready").catch(() => undefined);
  await page.mouse.move(W - 160, H / 2 + 40);
  await wait(settle);
}

const INTRO = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;height:100%;background:#fff;font-family:Archivo,system-ui,sans-serif;color:#111110;-webkit-font-smoothing:antialiased}
  body{display:grid;place-items:center}
  .c{display:grid;justify-items:center;gap:26px}
  svg{width:200px;height:200px;overflow:visible}
  .l{animation:l 1s cubic-bezier(.23,1,.32,1) .25s both}
  .r{animation:r 1s cubic-bezier(.23,1,.32,1) .25s both}
  .d{transform-origin:16px 16px;animation:d .7s cubic-bezier(.34,1.56,.64,1) .95s both}
  @keyframes l{from{transform:translateX(-14px);opacity:0}to{transform:none;opacity:1}}
  @keyframes r{from{transform:translateX(14px);opacity:0}to{transform:none;opacity:1}}
  @keyframes d{from{transform:scale(0)}to{transform:scale(1)}}
  h1{margin:0;font-size:92px;font-weight:800;font-stretch:92%;letter-spacing:-.05em;line-height:1;animation:up .8s cubic-bezier(.23,1,.32,1) 1.35s both}
  p{margin:0;font:600 20px/1 'JetBrains Mono',monospace;color:#8a5a00;letter-spacing:.02em;animation:up .8s cubic-bezier(.23,1,.32,1) 1.6s both}
  @keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
</style></head><body><div class="c">
  <svg viewBox="0 0 32 32"><path class="l" d="M11.5 5.5H6.5v21h5" fill="none" stroke="#111110" stroke-width="3.4"/><path class="r" d="M20.5 5.5h5v21h-5" fill="none" stroke="#111110" stroke-width="3.4"/><circle class="d" cx="16" cy="16" r="4.2" fill="#f5a400"/></svg>
  <h1>paylet</h1>
  <p>FAIR DROPS FOR THE AGENT ERA</p>
</div></body></html>`;

const OUTRO = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;height:100%;background:#fff;font-family:Archivo,system-ui,sans-serif;color:#111110;-webkit-font-smoothing:antialiased}
  body{display:grid;place-items:center}
  .c{display:grid;justify-items:center;gap:20px;text-align:center}
  svg{width:96px;height:96px;overflow:visible;animation:up .8s cubic-bezier(.23,1,.32,1) .1s both}
  h1{margin:4px 0 0;font-size:72px;font-weight:800;font-stretch:92%;letter-spacing:-.05em;line-height:1;animation:up .8s cubic-bezier(.23,1,.32,1) .3s both}
  .t{margin:0;font-size:26px;font-weight:600;font-stretch:92%;letter-spacing:-.02em;animation:up .8s cubic-bezier(.23,1,.32,1) .5s both}
  .t b{position:relative;padding:0 .14em;margin:0 .06em}
  .t b::before,.t b::after{content:"";position:absolute;top:.1em;bottom:0;width:.16em;border:.09em solid #f5a400}
  .t b::before{left:-.04em;border-right:0}.t b::after{right:-.04em;border-left:0}
  .u{display:flex;gap:12px;margin-top:18px;animation:up .8s cubic-bezier(.23,1,.32,1) .8s both}
  .u span{padding:11px 18px;border-radius:10px;font:600 17px/1 'JetBrains Mono',monospace}
  .u span:first-child{background:#111110;color:#fff}.u span:last-child{background:#f4f4f1}
  small{margin-top:26px;font:600 13px/1 'JetBrains Mono',monospace;color:#8a5a00;letter-spacing:.04em;animation:up .8s ease 1.2s both}
  @keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
</style></head><body><div class="c">
  <svg viewBox="0 0 32 32"><path d="M11.5 5.5H6.5v21h5" fill="none" stroke="#111110" stroke-width="3.4"/><path d="M20.5 5.5h5v21h-5" fill="none" stroke="#111110" stroke-width="3.4"/><circle cx="16" cy="16" r="4.2" fill="#f5a400"/></svg>
  <h1>paylet</h1>
  <p class="t">One unit per <b>PayPal account</b>. Agents welcome.</p>
  <div class="u"><span>paylet.onrender.com</span><span>github.com/KaraAliOsman/paylet</span></div>
  <small>PAYPAL SANDBOX ONLY · MIT LICENSED</small>
</div></body></html>`;

// HEADED=1: a real window, so Chrome uses the GPU (the animated hero drops to ~9 fps in software rendering)
// The window sits off-screen so no stray mouse or wheel on the desktop can touch it, and Chrome is told to keep
// painting it at full rate even though it is not visible.
const browser = await chromium.launch(
  process.env.HEADED
    ? {
        headless: false,
        args: [
          "--ignore-gpu-blocklist",
          "--enable-gpu-rasterization",
          "--window-position=-3000,0",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ],
      }
    : {},
);
// Drop A: the real-money drop (agent + PayPal + duplicate + swarm + real capture). Drop B: scale, AI review, failed payment.
const A = await post("/api/judge-drop", ADMIN);
const B = await post("/api/judge-drop", ADMIN);
await post(`/api/seller/${A.slug}/negative-test`, A.sellerKey, { on: false });
console.log("drop A", A.slug, "drop B", B.slug);

await scene(browser, "00-intro", async (page) => {
  await page.setContent(INTRO, { waitUntil: "load" });
  await page.evaluate("document.fonts.ready");
  await page.mouse.move(-50, -50);
  mark("start");
  await wait(3600);
});

await scene(browser, "01-home", async (page) => {
  await open(page, "/", 400);
  mark("start");
  await wait(7600); // the headline's hold brackets close, the proof ledger replays
  // hard cuts between sections (a smooth scroll renders at ~15 fps in a recorded browser)
  await page.evaluate("document.querySelector('.rules').scrollIntoView({ block: 'center' })");
  mark("rules");
  await wait(3600);
  await page.evaluate("document.querySelector('.outcomes').scrollIntoView({ block: 'center' })");
  mark("outcomes");
  await wait(600);
  await glideTo(page, page.getByRole("tab", { name: "Not selected" }));
  await wait(2600);
  mark("flow");
  await wait(600);
});

await scene(browser, "02-drop", async (page) => {
  await open(page, `/d/${A.slug}`, 300);
  await page.locator("paypal-button").waitFor({ timeout: 30_000 });
  mark("start");
  await wait(1200);
  await glideTo(page, page.locator(".ballot-steps"), false);
  await wait(1800);
  await glideTo(page, page.locator("paypal-button"), false);
  await wait(3800);
});

await scene(browser, "03-agent", async (page) => {
  await open(page, `/agent?drop=${A.slug}`, 400);
  mark("start");
  await wait(1400);
  await glideTo(page, page.getByRole("button", { name: /Get me into this drop/ }));
  mark("asked");
  await page.getByText(/Your agent stopped here/).waitFor({ timeout: 120_000 });
  mark("handoff");
  await page.getByText(/Your agent stopped here/).scrollIntoViewIfNeeded();
  await wait(2600);
  const link = page.getByRole("link", { name: /Approve .* hold in PayPal/ });
  await glideTo(page, link, false);
  await wait(900);
  const href = await link.getAttribute("href");
  await page.mouse.down();
  await page.mouse.up();
  await page.goto(href!);
  mark("paypal");
  await approveInPayPal(page, BUYER);
  mark("approved");
  await page.waitForURL(/\/me\//, { timeout: 90_000 });
  await page.getByText(/Hold placed/).first().waitFor({ timeout: 60_000 });
  mark("held");
  await wait(4200);
});

await scene(browser, "04-duplicate-and-swarm", async (page, ctx) => {
  await open(page, `/d/${A.slug}`, 400);
  await page.locator("paypal-button").waitFor({ timeout: 30_000 });
  mark("start");
  await wait(800);
  const popupPromise = ctx.waitForEvent("page", { timeout: 30_000 });
  await glideTo(page, page.locator("paypal-button"));
  mark("clicked");
  const popup = await popupPromise;
  await approveInPayPal(popup, BUYER);
  await popup.waitForEvent("close", { timeout: 90_000 }).catch(() => undefined);
  const dup = page.getByText(/already has an entry/).first();
  await dup.waitFor({ timeout: 60_000 });
  await dup.scrollIntoViewIfNeeded();
  mark("dup");
  await wait(4200);
  await open(page, `/seller/${A.slug}?k=${A.sellerKey}`, 300);
  mark("console");
  await wait(900);
  await glideTo(page, page.getByTestId("step-swarm"));
  mark("swarm");
  await page.getByTestId("step-swarm-result").filter({ hasText: /PayPal links · 0 holds/ }).waitFor({ timeout: 90_000 });
  mark("swarmed");
  await wait(1500);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  mark("ledger");
  await wait(4000);
});

await scene(browser, "05-crowd-ai", async (page) => {
  await open(page, `/seller/${B.slug}?k=${B.sellerKey}`, 300);
  mark("start");
  await wait(600);
  await glideTo(page, page.getByTestId("step-crowd"));
  mark("crowd");
  await page.getByTestId("step-crowd-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 30_000 });
  await wait(1200);
  await glideTo(page, page.getByTestId("step-ai"));
  mark("ai");
  await page.getByTestId("cluster-operator").first().waitFor({ timeout: 180_000 });
  mark("clusters");
  await page.getByTestId("cluster-operator").first().scrollIntoViewIfNeeded();
  await page.mouse.move(W - 160, H / 2, { steps: 10 });
  await glide(page, 160, 800);
  await wait(7000);
  mark("decide");
  let pending = await page.getByTestId("cluster-confirm").count();
  while (pending > 0) {
    await glideTo(page, page.getByTestId("cluster-confirm").first());
    await wait(1300);
    pending = await page.getByTestId("cluster-confirm").count();
  }
  mark("decided");
  await wait(1500);
  await open(page, "/evals", 300);
  mark("evals");
  await wait(800);
  await glideTo(page, page.locator(".evals table").first().locator("tr").last(), false);
  await wait(5500);
});

await scene(browser, "06-draw", async (page) => {
  await open(page, `/seller/${B.slug}?k=${B.sellerKey}`, 300);
  mark("start");
  await wait(600);
  await glideTo(page, page.getByTestId("step-draw"));
  await wait(500);
  await glideTo(page, page.getByTestId("confirm-ok"));
  mark("draw");
  await page.getByTestId("step-draw-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 180_000 });
  mark("drawn");
  await wait(1200);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  mark("ledger");
  await wait(5000);
  await page.locator(".report").first().scrollIntoViewIfNeeded().catch(() => undefined);
  mark("report");
  await wait(4500);
  // drop A: the real PayPal partial capture
  await open(page, `/seller/${A.slug}?k=${A.sellerKey}`, 300);
  mark("a-start");
  await glideTo(page, page.getByTestId("step-draw"));
  await wait(400);
  await glideTo(page, page.getByTestId("confirm-ok"));
  mark("a-draw");
  await page.getByTestId("step-draw-row").and(page.locator('[data-state="done"]')).waitFor({ timeout: 180_000 });
  mark("a-drawn");
  await wait(1000);
  await page.getByTestId("ledger").scrollIntoViewIfNeeded();
  mark("a-ledger");
  await wait(5500);
});

await scene(browser, "07-verify", async (page) => {
  await open(page, `/verify/${B.slug}`, 300);
  mark("start");
  await wait(600);
  await glideTo(page, page.getByRole("button", { name: /Re-run the draw here/ }));
  mark("rerun");
  const ok = page.getByText("Recorded outcome is consistent with your computation.");
  await ok.waitFor({ timeout: 30_000 });
  await ok.scrollIntoViewIfNeeded();
  mark("consistent");
  await wait(2500);
  await open(page, `/verify/${A.slug}`, 300);
  mark("a-start");
  const ask = page.getByRole("button", { name: /Ask PayPal now/ });
  await glideTo(page, ask);
  mark("ask");
  await wait(5000);
});

await scene(browser, "08-how", async (page) => {
  await open(page, "/how?reveal=1", 200);
  mark("start");
  await glide(page, 330, 1200);
  await wait(13500);
});

await scene(browser, "09-outro", async (page) => {
  await page.setContent(OUTRO, { waitUntil: "load" });
  await page.evaluate("document.fonts.ready");
  await page.mouse.move(-50, -50);
  await wait(800);
  mark("start");
  await wait(5600);
});

await browser.close();
