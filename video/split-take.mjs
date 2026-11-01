// Splits the one-take ElevenLabs file into the 13 narration lines using Scribe word timestamps.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const words = JSON.parse(readFileSync("vo-user/stt.json", "utf8")).words.filter((w) => w.type === "word");
const starts = [
  ["01", "so limited"], ["02", "every entry"], ["03a", "this is my"], ["03b", "so i approve"], ["04a", "same paypal"],
  ["04b", "twelve scalper"], ["05a", "to show scale"], ["05b", "on a blind"], ["06a", "at close"], ["06b", "and this one"],
  ["07", "and you don't"], ["08", "under the hood"], ["09", "paylett"],
];
const clean = (t) => t.toLowerCase().replace(/[^a-z' ]/g, "");
let from = 0;
const idx = starts.map(([id, phrase]) => {
  const p = phrase.split(" ");
  for (let i = from; i < words.length; i++) {
    if (p.every((w, k) => clean(words[i + k]?.text ?? "") === w)) { from = i + 1; return [id, i]; }
  }
  throw new Error("not found: " + phrase);
});
const total = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "vo-user/full.mp3"]).toString();
idx.forEach(([id, i], n) => {
  const first = words[i];
  const lastIdx = n + 1 < idx.length ? idx[n + 1][1] - 1 : words.length - 1;
  const last = words[lastIdx];
  const prevEnd = i > 0 ? words[i - 1].end : 0;
  const nextStart = n + 1 < idx.length ? words[idx[n + 1][1]].start : total;
  const a = Math.max(prevEnd + 0.02, first.start - 0.12);
  const b = Math.min(nextStart - 0.02, last.end + 0.25);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", "vo-user/full.mp3", "-ss", a.toFixed(3), "-to", b.toFixed(3),
    "-af", "highpass=f=70,afade=t=in:d=0.02,areverse,afade=t=in:d=0.08,areverse", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", `vo-user/${id}.wav`]);
  console.log(id, a.toFixed(2), "→", b.toFixed(2), (b - a).toFixed(1) + " s", "|", words.slice(i, lastIdx + 1).map((w) => w.text).join(" ").slice(0, 70));
});
