# The demo video, reproducibly

Everything that makes `paylet-demo.mp4` lives in this repo, except the keys (read from env files outside the repo).

| Step | What | How |
|---|---|---|
| 1. Footage | 10 scenes recorded against the live demo with the real PayPal sandbox (a sandbox buyer approves in PayPal; real capture of $44.50). Native 1080p, drawn cursor, no address bar, sandbox email blurred. Each scene writes `<scene>.marks.json`. | `HEADED=1 node --env-file=../.secrets/buyer.env --env-file=../.secrets/seller_admin.env --import tsx scripts/record-video.ts` |
| 2. Voice | The narration in [`narration.json`](narration.json), performed by the author's own ElevenLabs voice clone. Either generated per line with take selection ([`vo-pro.mjs`](vo-pro.mjs): `eleven_v3` with audio tags, three takes per line scored with Scribe speech-to-text), or exported in one take from the ElevenLabs app and cut into lines on Scribe word timestamps ([`split-take.mjs`](split-take.mjs)). The final video uses the one-take export. | `node --env-file=<elevenlabs.env> vo-pro.mjs` or `node split-take.mjs` |
| 3. Music | ElevenLabs Music, instrumental, 3:00. Prompt below. | `POST /v1/music` |
| 4. Edit | Cuts the waits (PayPal login, model thinking) to a target length, places each voice line on its action, chapter labels in the brand's hold tag, logo intro and outro; voice levelled linearly (two-pass loudnorm), music ducked under the voice with a slow sidechain, true-peak limiter. | `VO_DIR=vo-user node scripts/edit-video.mjs` |

Music prompt:

> Instrumental background music for a polished fintech product demo video. Minimal modern electronic with warm felt
> piano, soft analog synth pads, gentle pulsing bass and crisp light percussion. Confident, optimistic, focused,
> understated. Steady 104 BPM, no drops, no vocals, no big build-ups. Designed to sit quietly under a voice-over.

Product photos in the demo drops: Unsplash License (credits in the main README).
