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
import type { MicMode } from '../src/config.ts';
import { parseHotkey } from '../src/asr/hotkey.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';
import { fakeSapi } from './helpers/fake-sapi.ts';

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

/** A talk key the test presses; `problem` makes it unreadable. */
function scriptedKey(problem?: string) {
  const key = { press: (_down: boolean) => {}, codes: [] as number[] };
  const watch = async (codes: number[], onChange: (down: boolean) => void) => {
    if (problem) return problem;
    key.codes = codes;
    key.press = onChange;
    return { stop: () => {} };
  };
  return { key, watch };
}

async function setup(text: string, mode: MicMode = 'always', watch?: ReturnType<typeof scriptedKey>['watch']) {
  const ep = await endpoint(text);
  cleanup.push(() => new Promise((r) => ep.server.close(() => r())));
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  cfg.asr.engine = 'whisper';
  cfg.asr.baseUrl = ep.url;
  cfg.asr.mic.mode = mode;
  const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
  const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'), watchHotkey: watch });
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

  it('hold: only audio while the talk key is down counts, and releasing the key ends the utterance', async () => {
    const { key, watch } = scriptedKey();
    const { ep, host, page, world } = await setup('帮我看看这个', 'hold', watch);
    expect(key.codes).toEqual(parseHotkey(DESKTOP_PET_DEFAULTS.asr.mic.hotkey));
    for (const fr of tone(600, .3)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 200));
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
    key.press(true);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    // quiet speech still counts while the key is held, pauses included
    for (const fr of [...tone(500, .01), ...tone(800, 0), ...tone(300, .01)]) page.audio(fr);
    await new Promise((r) => setTimeout(r, 200));
    expect(ep.bodies).toHaveLength(0);
    key.press(false);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0].text).toBe('[语音] 主人:帮我看看这个');
    expect(ep.bodies).toHaveLength(1);
  });

  it('a talk key that cannot be read falls back to listening all the time', async () => {
    const { watch } = scriptedKey('no keyboard here');
    const { host, page, world } = await setup('还是听得见', 'hold', watch);
    expect(world.voiceState().input).toMatchObject({ mode: 'hold', effectiveMode: 'always', hotkeyProblem: 'no keyboard here', open: true });
    for (const fr of [...tone(900, .3), ...tone(900, 0)]) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
  });

  it('the microphone button held down sends the sentence without waiting for its closing pause', async () => {
    const { ep, host, page } = await setup('帮我开灯');
    // speech with no pause after it: the segmenter is still inside the sentence
    for (const fr of tone(600, .3)) page.audio(fr);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    await new Promise((r) => setTimeout(r, 300));
    expect(ep.bodies).toHaveLength(0);
    page.send({ t: 'commit' });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0].text).toBe('[语音] 主人:帮我开灯');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('帮我开灯');
  });

  it('toggle: sending the sentence switches the talk key off', async () => {
    const { key, watch } = scriptedKey();
    const { host, page, world } = await setup('好了', 'toggle', watch);
    key.press(true); key.press(false);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(600, .3)) page.audio(fr);
    page.send({ t: 'commit' });
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect((world.voiceState().input as { open: boolean }).open).toBe(false);
  });

  it('the button held down with nothing heard closes the listening bubble and sends nothing', async () => {
    const { key, watch } = scriptedKey();
    const { ep, host, page } = await setup('x', 'toggle', watch);
    key.press(true); key.press(false);
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    page.send({ t: 'commit' });
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(ep.bodies).toHaveLength(0);
    expect(host.events).toHaveLength(0);
  });

  it('system engine: the bubble shows the sentence while it is spoken, then the event carries the final text', async () => {
    const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
    Object.assign(cfg, { enabled: true, port: 0 });
    cfg.window.enabled = false;
    cfg.asr.engine = 'system';
    cfg.asr.mic.mode = 'always';
    // one character per 100 ms of audio heard so far; the final text settles on the whole sentence
    const { spawnImpl, spawned } = fakeSapi({ partial: (n) => '听'.repeat(Math.floor(n / 3200)) || null, final: () => '听清楚了' });
    const dir = mkdtempSync(join(tmpdir(), 'pet-voice-'));
    const world = new DesktopPetWorld({ cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'), spawnSystemRecognizer: spawnImpl });
    const host = new FakeHost();
    await world.start(host);
    cleanup.push(() => world.stop());
    await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('running');
    const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
    cleanup.push(() => page.close());

    for (const fr of tone(600, .3)) page.audio(fr);
    const live = await page.next((m) => m.t === 'listen' && m.phase === 'partial' && typeof m.interim === 'string' && m.interim.length >= 3);
    expect(live.text).toBe('');
    expect(host.events).toHaveLength(0);
    for (const fr of tone(900, 0)) page.audio(fr);
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0].text).toBe('[语音] 主人:听清楚了');
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('听清楚了');
    // one streamed sentence, not a second pass over the finished audio
    expect(spawned[0].lines.filter((l) => l.startsWith('B '))).toHaveLength(1);
  });

  it('ignores quiet input', async () => {
    const { ep, page, world } = await setup('x');
    for (const fr of tone(1500, .002)) page.audio(fr);
    await new Promise((r) => setTimeout(r, 400));
    expect(ep.bodies).toHaveLength(0);
    expect((world.voiceState().counts as { utterances: number }).utterances).toBe(0);
  });
});
