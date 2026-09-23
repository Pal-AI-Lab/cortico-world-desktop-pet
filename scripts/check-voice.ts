/**
 * Manual end-to-end check of voice input against a real whisper.cpp server.
 *
 *   npx tsx scripts/check-voice.ts <whisper-server> <ggml model> <speech.wav>
 *
 * Mounts the World with the managed server pointed at the given files, streams the WAV
 * (mono PCM16, any rate) over the pet socket in 20 ms frames, and prints the speech event.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';
import { FakePage } from '../tests/helpers/page.ts';

const [serverFile, modelFile, wavFile] = process.argv.slice(2);
if (!serverFile || !modelFile || !wavFile) throw new Error('usage: check-voice.ts <whisper-server> <model> <wav>');

function readWav(file: string): Int16Array {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24);
  let at = 12;
  while (b.toString('ascii', at, at + 4) !== 'data') at += 8 + b.readUInt32LE(at + 4);
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + b.readUInt32LE(at + 4)));
  const out = new Int16Array(Math.floor(pcm.length * 16000 / rate));
  for (let i = 0; i < out.length; i++) out[i] = pcm[Math.floor(i * rate / 16000)];
  return out;
}

const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
Object.assign(cfg, { enabled: true, port: 0 });
cfg.window.enabled = false;
cfg.asr.serverFile = serverFile;
cfg.asr.modelFile = modelFile;
cfg.asr.baseUrl = 'http://127.0.0.1:8799/v1';
const dir = mkdtempSync(join(tmpdir(), 'pet-check-'));
const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => dir, modelsDir: () => dir });
const host = new FakeHost();
await world.start(host);
const t0 = Date.now();
const st = await world.startVoiceBackend();
console.log('server', st, `${Date.now() - t0} ms`);
const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
const pcm = readWav(wavFile);
const frames = Math.ceil(pcm.length / 320);
for (let f = 0; f < frames + 60; f++) {
  const fr = new Int16Array(320);
  if (f < frames) fr.set(pcm.subarray(f * 320, f * 320 + 320));
  page.audio(fr);
  await new Promise((r) => setTimeout(r, 5));
}
const deadline = Date.now() + 60_000;
while (host.events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
console.log('events', host.events.map((e) => e.text));
console.log('voice', JSON.stringify(world.voiceState().recent));
await page.close();
await world.stop();
process.exit(host.events.length ? 0 : 1);
