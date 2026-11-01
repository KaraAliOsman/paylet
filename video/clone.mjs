// Creates a new instant voice clone from every file in voice-samples/ (noise removal on) and prints its voice_id.
//   node --env-file=../../.secrets/elevenlabs.env clone.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const files = readdirSync("voice-samples").filter((f) => /\.(mp3|m4a|wav|ogg|webm|flac|aac)$/i.test(f));
if (!files.length) throw new Error("no samples in voice-samples/");
const form = new FormData();
form.append("name", `efa – Paylet ${new Date().toISOString().slice(0, 10)}`);
form.append("description", "Ali, natural English with a Turkish accent, calm and confident narration.");
form.append("remove_background_noise", "true");
form.append("labels", JSON.stringify({ language: "en", use_case: "narration" }));
for (const f of files) form.append("files", new Blob([readFileSync(`voice-samples/${f}`)]), f);
const r = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form });
const j = await r.json();
if (!r.ok) throw new Error(JSON.stringify(j));
writeFileSync("voice-id.txt", j.voice_id);
console.log("voice_id", j.voice_id, "from", files.join(", "));
