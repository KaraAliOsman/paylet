// Voice-over, done the way ElevenLabs recommends for an instant clone:
//  - eleven_multilingual_v2 (the most faithful model for cloned voices), stability high enough to avoid the
//    hesitations of a conversational sample, similarity high, style low, speaker boost on;
//  - request stitching (previous_text / next_text) so every line keeps the same prosody;
//  - TAKES takes per line with different seeds, each transcribed with Scribe (speech-to-text) and scored against the
//    script: wrong/missing words, fillers ("uh", "um") and stutters ("I, I") cost points; the best take wins;
//  - post: only a rumble cut and silence trim (no compressor or de-esser: they dull a cloned voice); level set in the edit.
//   node --env-file=../../.secrets/elevenlabs.env vo-pro.mjs [ids]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = existsSync("voice-id.txt") ? readFileSync("voice-id.txt", "utf8").trim() : "bGZe8SXM4uPy6XiOVd6M";
const TAKES = Number(process.env.TAKES ?? 3);
// eleven_v3 performs the audio tags ([thoughtful], [chuckles], [short pause]) and varies the delivery; v2 reads them aloud
const MODEL = process.env.MODEL ?? "eleven_v3";
const V3 = MODEL.startsWith("eleven_v3");
const lines = JSON.parse(readFileSync("narration.json", "utf8"));
const only = process.argv[2]?.split(",");
mkdirSync("vo/takes", { recursive: true });

const norm = (s) =>
  s.replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/\bgoing to\b/g, "gonna").replace(/\bshould have\b/g, "should've").replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

/** word-level edit distance */
function wer(ref, hyp) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  return d[ref.length][hyp.length];
}

// numbers are spoken as words in the script; Scribe may write digits
const spoken = (w) => w.replace(/(v?ren|wren)/gi, "wren").replace(/(pay-?let|paylett|payette|palette|paylette)/gi, "paylet").replace(/\b48\b/g, "forty eight").replace(/\b12\b/g, "twelve").replace(/\b11\b/g, "eleven");

async function tts(line, i, seed) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(
      V3
        ? {
            // v3: the tags direct the performance; "Natural" stability keeps it expressive but faithful to the voice
            text: line.text.replace(/Paylet/g, "Pay-let").replace(/Wren/g, "Ren"),
            model_id: MODEL,
            seed,
            voice_settings: { stability: 0.5, similarity_boost: 0.85, use_speaker_boost: true },
          }
        : {
            text: line.text.replace(/Paylet/g, "Pay-let"),
            model_id: MODEL,
            language_code: "en",
            seed,
            previous_text: lines[i - 1]?.text.replace(/Paylet/g, "Pay-let"),
            next_text: lines[i + 1]?.text.replace(/Paylet/g, "Pay-let"),
            voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0, use_speaker_boost: true, speed: 1.0 },
          },
    ),
  });
  if (!r.ok) throw new Error(`${line.id} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function transcribe(file) {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("language_code", "en");
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([readFileSync(file)]), "take.mp3");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": KEY }, body: form });
  const j = await r.json();
  return j.text ?? "";
}

const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();
const report = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (only && !only.includes(line.id)) continue;
  const ref = norm(spoken(line.text));
  const takes = [];
  for (let k = 0; k < TAKES; k++) {
    const seed = 1000 + k * 7919 + i;
    const file = `vo/takes/${line.id}-${k}.mp3`;
    writeFileSync(file, await tts(line, i, seed));
    const text = await transcribe(file);
    const hyp = norm(spoken(text));
    const isFiller = (w) => /^(uh|um|erm|uhm|hmm|ah)$/.test(w);
    // fillers written into the script are part of the performance; only extra ones cost points
    const fillers = Math.max(0, hyp.filter(isFiller).length - ref.filter(isFiller).length);
    const repeats = hyp.filter((w, j) => j > 0 && w === hyp[j - 1] && w.length > 1).length;
    const errors = wer(ref, hyp);
    const score = errors + fillers * 3 + repeats * 3;
    takes.push({ k, file, text, errors, fillers, repeats, score, len: dur(file) });
  }
  // best score; ties → the take closest to the median length (no rushed or dragged reads)
  const med = takes.map((t) => t.len).sort((a, b) => a - b)[Math.floor(takes.length / 2)];
  takes.sort((a, b) => a.score - b.score || Math.abs(a.len - med) - Math.abs(b.len - med));
  const best = takes[0];
  // post-production: rumble cut, gentle compression, de-ess, short fade so cuts never click
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", best.file,
    "-af", "highpass=f=70,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.15,areverse,afade=t=in:d=0.01",
    "-ar", "48000", "-c:a", "pcm_s16le", `vo/${line.id}.wav`,
  ]);
  report.push({ id: line.id, pick: best.k, score: best.score, errors: best.errors, fillers: best.fillers, repeats: best.repeats, len: +dur(`vo/${line.id}.wav`).toFixed(2), heard: best.text });
  console.log(`${line.id}: take ${best.k} (score ${best.score}; ${takes.map((t) => t.score).join("/")}) ${best.len.toFixed(1)} s`);
}
writeFileSync("vo/report.json", JSON.stringify(report, null, 1));
