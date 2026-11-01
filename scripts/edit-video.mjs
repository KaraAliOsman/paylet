// Cuts the recorded scenes (scripts/record-video.ts) into the final demo video with the voice-over placed on the action.
// Each scene: video segments between marks (slow waits are sped up to a target length), voice cues placed at a mark (never
// overlapping the previous cue), the last frame held until the voice ends. Then all scenes are joined.
//   node scripts/edit-video.mjs [videoDir]        (videoDir defaults to ../entrega/video; needs ffmpeg on PATH)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2] ?? "../entrega/video";
const only = process.argv[3]?.split(",");
const FPS = 30;

// [from, to, target seconds or null] — from/to are "mark" or "mark+1.2" / "mark-0.5"
const EDL = {
  "01-home": { seg: [["start-0.3", "flow+1.4", null]], vo: [["01", "start+0.7"]] },
  "02-drop": { seg: [["start-0.2", "start+7.6", null]], vo: [["02", "start+0.5"]] },
  "03-agent": {
    seg: [
      ["start-0.2", "asked+1.2", null],
      ["asked+1.2", "handoff-0.2", 2.2],
      ["handoff-0.2", "paypal+0.8", null],
      ["paypal+0.8", "approved", 3.2],
      ["approved", "held-0.6", 1.6],
      ["held-0.6", "end", null],
    ],
    vo: [["03a", "start+0.4"], ["03b", "paypal+0.9"]],
    // the sandbox buyer's email is printed as text on PayPal's password step
    blur: [[560, 360, 800, 60, "paypal", "approved"]],
  },
  "04-duplicate-and-swarm": {
    seg: [
      ["start-0.2", "clicked+0.8", null],
      ["clicked+0.8", "dup-0.4", 1.4],
      ["dup-0.4", "dup+3.6", null],
      ["console-0.1", "swarm+0.6", null],
      ["swarm+0.6", "swarmed", 2.0],
      ["swarmed", "end", null],
    ],
    vo: [["04a", "start+0.3"], ["04b", "console+0.3"]],
  },
  "05-crowd-ai": {
    seg: [
      ["start-0.2", "ai+0.8", null],
      ["ai+0.8", "clusters", 2.4],
      ["clusters", "decided+1.0", null],
      ["evals-0.1", "end", null],
    ],
    vo: [["05a", "start+0.3"], ["05b", "evals+0.4"]],
  },
  "06-draw": {
    seg: [
      ["start-0.2", "draw+0.6", null],
      ["draw+0.6", "drawn", 2.5],
      ["drawn", "a-start-0.1", null],
      ["a-start-0.1", "a-draw+0.6", null],
      ["a-draw+0.6", "a-drawn", 1.8],
      ["a-drawn", "end", null],
    ],
    vo: [["06a", "start+0.3"], ["06b", "a-ledger+0.2"]],
  },
  "07-verify": { seg: [["start-0.2", "consistent+1.6", null], ["a-start-0.1", "ask+3.2", null]], vo: [["07", "start+0.4"]] },
  "08-how": { seg: [["start-0.2", "end", null]], vo: [["08", "start+1.0"]] },
  "09-outro": { seg: [["start-0.6", "end", null]], vo: [["09", "start+0.6"]] },
};

const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();

const parts = [];
let total = 0;
for (const [name, cfg] of Object.entries(EDL)) {
  const raw = `${dir}/raw/${name}.webm`;
  const out = `${dir}/clips/${name}.mp4`;
  if (only && !only.includes(name.slice(0, 2))) {
    if (existsSync(out)) parts.push(out);
    continue;
  }
  const marks = JSON.parse(readFileSync(`${dir}/raw/${name}.marks.json`, "utf8"));
  const rawDur = dur(raw);
  const at = (expr) => {
    const m = /^(.+?)([+-]\d+(?:\.\d+)?)?$/.exec(expr);
    const t = marks[m[1]];
    if (t === undefined) throw new Error(`${name}: no mark ${m[1]}`);
    return Math.max(0, Math.min(rawDur, t + (m[2] ? +m[2] : 0)));
  };
  // segments in raw time → output time
  const segs = [];
  let o = 0;
  for (const [f, t, target] of cfg.seg) {
    const a = at(f);
    const b = at(t);
    if (b - a < 0.05) continue;
    const speed = target && b - a > target ? (b - a) / target : 1;
    segs.push({ a, b, speed, o });
    o += (b - a) / speed;
  }
  const map = (t) => {
    for (const s of segs) {
      if (t < s.a) return s.o;
      if (t <= s.b) return s.o + (t - s.a) / s.speed;
    }
    return o;
  };
  // voice cues, never overlapping
  let end = 0;
  const cues = cfg.vo.map(([id, expr]) => {
    const want = map(at(expr));
    const start = Math.max(want, end > 0 ? end + 0.3 : 0);
    const len = dur(`${dir}/vo/${id}.mp3`);
    end = start + len;
    return { id, want: +want.toFixed(2), start: +start.toFixed(2), len: +len.toFixed(2) };
  });
  const length = Math.max(o, end + 0.9);
  const hold = length - o;

  const inputs = ["-i", raw, ...cues.flatMap((c) => ["-i", `${dir}/vo/${c.id}.mp3`])];
  const pre = [];
  let src = "[0:v]";
  if (cfg.blur?.length) {
    let cur = "[0:v]";
    cfg.blur.forEach(([x, y, w, h, f, t], i) => {
      pre.push(`${cur}split[bs${i}][bc${i}]`, `[bc${i}]crop=${w}:${h}:${x}:${y},boxblur=14:2[bb${i}]`, `[bs${i}][bb${i}]overlay=${x}:${y}:enable='between(t,${at(f).toFixed(2)},${at(t).toFixed(2)})'[bo${i}]`);
      cur = `[bo${i}]`;
    });
    src = cur;
  }
  if (src !== "[0:v]") {
    pre.push(`${src}split=${segs.length}${segs.map((_, i) => `[sv${i}]`).join("")}`);
  }
  const inp = (i) => (src === "[0:v]" ? "[0:v]" : `[sv${i}]`);
  const v = segs.map((s, i) => `${inp(i)}trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)},fps=${FPS}[v${i}]`);
  const vcat = `${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p[vout]`;
  const a = cues.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
  const amix = `${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${length.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=9[aout]`;
  run([
    ...inputs,
    "-filter_complex",
    [...pre, ...v, vcat, ...a, amix].join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-r", String(FPS), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", length.toFixed(3),
    out,
  ]);
  total += length;
  parts.push(out);
  console.log(
    `${name}: ${length.toFixed(1)} s (video ${o.toFixed(1)} + hold ${hold.toFixed(1)})`,
    segs.map((s) => `${s.a.toFixed(1)}-${s.b.toFixed(1)}${s.speed > 1 ? `×${s.speed.toFixed(1)}` : ""}`).join(" "),
    cues.map((c) => `${c.id}@${c.start}${c.start > c.want + 0.05 ? `(wanted ${c.want})` : ""}+${c.len}`).join(" "),
  );
}

// join, with a short fade in and out
writeFileSync(`${dir}/clips/list.txt`, parts.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
run(["-f", "concat", "-safe", "0", "-i", `${dir}/clips/list.txt`, "-c", "copy", `${dir}/clips/_joined.mp4`]);
const full = dur(`${dir}/clips/_joined.mp4`);
run([
  "-i", `${dir}/clips/_joined.mp4`,
  "-vf", `fade=t=in:st=0:d=0.4,fade=t=out:st=${(full - 0.7).toFixed(2)}:d=0.7`,
  "-af", `afade=t=in:st=0:d=0.2,afade=t=out:st=${(full - 0.7).toFixed(2)}:d=0.7`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
  "-movflags", "+faststart",
  `${dir}/paylet-demo.mp4`,
]);
console.log(`paylet-demo.mp4: ${full.toFixed(1)} s`);
