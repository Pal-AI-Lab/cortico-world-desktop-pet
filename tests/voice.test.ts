/**
 * Voice input end to end inside the World: PCM frames over the pet socket → segmenter →
 * transcription endpoint (a local stand-in that speaks the OpenAI-compatible route) →
 * `desktop-pet.speech` event, with the listen phases the page shows along the way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';

interface Endpoint { url: string; bodies: string[]; reply: { text: string }; server: Server }

async function endpoint(text: string): Promise<Endpoint> {
  const ep = { bodies: [] as string[], reply: { text } } as Endpoint;
  ep.server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      let body = '';
      for await (const c of req) body += (c as Buffer).toString('latin1');
      ep.bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ep.reply));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => ep.server.listen(0, '127.0.0.1', () => r()));
  const addr = ep.server.address() as { port: number };
  ep.url = `http://127.0.0.1:${addr.port}/v1`;
  return ep;
}

const tone = (ms: number, amp: number) => {
  const frames: Int16Array[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const fr = new Int16Array(320);
    for (let i = 0; i < 320; i++) fr[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 440 * (f * 320 + i) / 16000));
    frames.push(fr);
  }
  return frames;
};

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(text: string) {
  const ep = await endpoint(text);
  cleanup.push(() => new Promise((r) => ep.server.close(() => r())));
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  cfg.asr.baseUrl = ep.url;
  const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
  const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm') });
  const host = new FakeHost();
  await world.start(host);
  cleanup.push(() => world.stop());
  // an endpoint that already answers is used as it is
  await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('external');
  const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
  cleanup.push(() => page.close());
  return { ep, world, host, page };
}

describe('voice input', () => {
  it('turns a spoken utterance into one speech event that wakes', async () => {
    const { ep, host, page } = await setup('今天天气怎么样');
    for (const fr of [...tone(900, .3), ...tone(900, 0)]) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-pet.speech', senderKey: 'desktop-pet.voice', text: '[语音] 主人:今天天气怎么样' });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('今天天气怎么样');
    expect(ep.bodies).toHaveLength(1);
    expect(ep.bodies[0]).toContain('RIFF');
    expect(ep.bodies[0]).toContain('name="language"');
  });

  it('drops a known hallucination and tells the page nothing was heard', async () => {
    const { host, page } = await setup('谢谢观看');
    for (const fr of [...tone(900, .3), ...tone(900, 0)]) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(host.events).toHaveLength(0);
  });

  it('ignores quiet input', async () => {
    const { ep, page, world } = await setup('x');
    for (const fr of tone(1500, .002)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 400));
    expect(ep.bodies).toHaveLength(0);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
  });
});
