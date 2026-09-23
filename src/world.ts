/**
 * DesktopPetWorld: the pet on the desktop as a World.
 *
 * Output goes through four tools that drive the pet page (bubble, options, walking,
 * expressions and motions). Input arrives as events: speech heard through the pet window's
 * microphone (transcribed by whisper.cpp), typed text, answers to `pet_ask`, and touches
 * (poke, petting, being thrown). The page reports what actually happened; receipts and
 * events state only that.
 *
 * Processes owned here: the page server (always, while mounted), the pet window (when
 * `window.enabled`) and the managed whisper.cpp server (when voice input is on and nothing
 * else answers at the endpoint).
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type {
  Logger, OutputTap, ToolDef, ToolOutcome, World, WorldConsoleDecl, WorldHost, WorldLamp, WorldPanelDecl, WorldStreamSocket,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  DESKTOP_PET_ASR_CONFIG_GROUP, DESKTOP_PET_CONFIG_GROUP, DESKTOP_PET_ID,
  type DesktopPetConfigSection, type PetSkin, type PetTheme, type RoamMode, type WhisperModel,
} from './config.ts';
import { PetServer, type PageMessage } from './server.ts';
import { WindowHost, resolveHostCommand } from './window-host.ts';
import { RuntimeStore, WHISPER_MODELS, type ArtifactState } from './runtime/store.ts';
import { WhisperServer, type WhisperServerState } from './asr/whisper-server.ts';
import { Packer, Segmenter, type Utterance } from './asr/segmenter.ts';
import { looksHallucinated, transcribe } from './asr/client.ts';
import { toSimplified } from './asr/simplify.ts';
import { estimateSeconds, parseActions, parseScript, vocabTable } from './script.ts';
import { DESKTOP_PET_TOOL_DECLS } from './tools.ts';

export const DESKTOP_PET_PANEL_DECLS: readonly WorldPanelDecl[] = [
  { id: 'pet', title: '桌宠', description: '窗口、装扮与窗口运行时。', getMethods: ['state'] },
  { id: 'voice', title: '语音输入', description: '识别服务、模型、电平与识别结果。', getMethods: ['state'] },
];

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const FRAME_MS = 20;
const SAMPLE_RATE = 16_000;
const WALK_TIMEOUT_MS = 30_000;
/** Touches of one kind closer than this are reported as one event with a count. */
const TOUCH_MERGE_MS = 2500;

export interface DesktopPetWorldOptions {
  cfg: DesktopPetConfigSection;
  timezone: string;
  persist: (patch: DeepPartial<DesktopPetConfigSection>) => void;
  runtimesRoot: () => string;
  modelsDir: () => string;
  fetchImpl?: typeof fetch;
}

interface PendingWalk {
  resolve: (text: string) => void;
  timer: NodeJS.Timeout;
}

interface PendingAsk {
  id: string;
  question: string;
  options: string[];
}

interface TouchBatch {
  kind: string;
  count: number;
  woke: boolean;
  asleep: boolean;
  x: number | null;
  crashed: boolean;
  timer: NodeJS.Timeout;
}

interface HeardLine { text: string; at: number; ms: number; dropped?: boolean }

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export class DesktopPetWorld implements World {
  readonly id = DESKTOP_PET_ID;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private readonly cfg: DesktopPetConfigSection;
  private readonly server: PetServer;
  private windowHost: WindowHost | null = null;
  private readonly store: RuntimeStore;
  private whisper: WhisperServer | null = null;
  private readonly segmenter: Segmenter;
  private readonly packer = new Packer({ joinGapMs: 0, maxHoldMs: 8000, minChars: 1 });
  private readonly queue: Utterance[] = [];
  private transcribing = false;
  private packTimer: NodeJS.Timeout | null = null;
  private wasSpeaking = false;
  private screen: { w: number; h: number } | null = null;
  private busyUntil = 0;
  private readonly walks = new Map<string, PendingWalk>();
  private ask: PendingAsk | null = null;
  private touch: TouchBatch | null = null;
  private prefsKey = '';
  private prefsTimer: NodeJS.Timeout | null = null;
  private thinking = false;
  private readonly voiceSockets = new Set<WorldStreamSocket>();
  private lastLevelAt = 0;
  private readonly heard: HeardLine[] = [];
  private readonly counts = { utterances: 0, delivered: 0, dropped: 0 };
  private micState: { state: string; detail: string | null } = { state: 'off', detail: null };

  constructor(private readonly opts: DesktopPetWorldOptions) {
    this.cfg = opts.cfg;
    this.segmenter = new Segmenter(opts.cfg.asr.segment, FRAME_MS);
    this.store = new RuntimeStore({ runtimesRoot: opts.runtimesRoot, modelsDir: opts.modelsDir, fetchImpl: opts.fetchImpl });
    this.server = new PetServer({
      port: () => this.cfg.port,
      webDir: WEB_DIR,
      snapshot: () => this.snapshot(),
      onPetMessage: (msg) => this.onPage(msg),
      onAudio: (frame) => this.onAudio(frame),
      onPetConnect: () => { this.log?.info('桌宠页面已连接'); },
      onPetDisconnect: () => this.onPageGone(),
      onSkin: (skin) => this.saveSkin(skin),
      onPrefs: (prefs) => this.savePrefs(prefs),
    });
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    await this.server.start();
    this.windowHost = new WindowHost(host.log);
    if (this.cfg.window.enabled) this.openWindow();
    this.whisper = new WhisperServer({
      baseUrl: () => this.cfg.asr.baseUrl,
      launch: () => this.whisperLaunch(),
      language: () => this.cfg.asr.language,
      threads: () => this.cfg.asr.threads,
      log: host.log,
      fetchImpl: this.opts.fetchImpl,
    });
    if (this.cfg.asr.enabled && this.cfg.asr.manageServer) void this.startVoiceBackend();
    this.prefsKey = this.prefsSignature();
    this.prefsTimer = setInterval(() => this.syncPrefs(), 1000);
  }

  async stop(): Promise<void> {
    if (this.prefsTimer) clearInterval(this.prefsTimer);
    this.prefsTimer = null;
    if (this.packTimer) clearTimeout(this.packTimer);
    this.packTimer = null;
    if (this.touch) clearTimeout(this.touch.timer);
    this.touch = null;
    for (const w of this.walks.values()) { clearTimeout(w.timer); w.resolve('World 已停止,没走到。'); }
    this.walks.clear();
    for (const s of this.voiceSockets) s.close('stopped');
    this.voiceSockets.clear();
    await this.windowHost?.stop();
    await this.whisper?.stop();
    await this.server.stop();
    this.host = null;
  }

  onTurnEnded(): void {
    this.setThinking(false);
  }

  outputTap(): OutputTap | undefined {
    if (!this.server.petConnected) return undefined;
    return {
      onEvent: () => this.setThinking(true),
      onRoundEnd: () => this.setThinking(false),
      onAbort: () => this.setThinking(false),
    };
  }

  private setThinking(on: boolean): void {
    if (this.thinking === on) return;
    this.thinking = on;
    this.server.sendPet({ t: 'thinking', on });
  }

  /* ---------- window ---------- */

  get petUrl(): string {
    return `${this.server.origin}/pet`;
  }

  openWindow(): void {
    if (!this.windowHost || !this.server.port) return;
    const managed = this.store.electron.executable();
    this.windowHost.start(resolveHostCommand(this.petUrl, this.cfg.window.electronFile, managed));
  }

  /* ---------- page protocol ---------- */

  private snapshot(): Record<string, unknown> {
    return {
      skin: this.cfg.skin,
      roam: this.cfg.roam,
      sound: this.cfg.sound,
      theme: this.cfg.theme,
      scale: this.cfg.window.scale,
      user: this.cfg.user,
      mic: this.micWanted(),
      thinking: this.thinking,
    };
  }

  private prefsSignature(): string {
    return JSON.stringify([this.cfg.roam, this.cfg.sound, this.cfg.theme, this.cfg.window.scale, this.cfg.user, this.micWanted(), this.cfg.skin]);
  }

  /** Config is a live object edited by the console; changes reach the pages within a second. */
  private syncPrefs(): void {
    this.segmenter.configure(this.cfg.asr.segment);
    const key = this.prefsSignature();
    if (key === this.prefsKey) return;
    this.prefsKey = key;
    this.server.broadcast({ t: 'prefs', ...this.snapshot() });
  }

  private micWanted(): boolean {
    const phase = this.whisper?.state().phase;
    return this.cfg.asr.enabled && (phase === 'running' || phase === 'external');
  }

  private saveSkin(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const skin = raw as PetSkin;
    this.opts.persist({ skin });
    this.syncPrefs();
  }

  private savePrefs(prefs: Record<string, unknown>): void {
    const patch: DeepPartial<DesktopPetConfigSection> = {};
    if (prefs.roam === 'free' || prefs.roam === 'calm' || prefs.roam === 'off') patch.roam = prefs.roam as RoamMode;
    if (typeof prefs.sound === 'boolean') patch.sound = prefs.sound;
    if (prefs.theme === 'dark' || prefs.theme === 'light') patch.theme = prefs.theme as PetTheme;
    if (typeof prefs.mic === 'boolean') patch.asr = { enabled: prefs.mic };
    if (Object.keys(patch).length) this.opts.persist(patch);
    if (typeof prefs.mic === 'boolean' && prefs.mic && this.cfg.asr.manageServer) void this.startVoiceBackend();
    this.syncPrefs();
  }

  private onPage(msg: PageMessage): void {
    switch (msg.t) {
      case 'hello': {
        const s = msg.screen as { w?: unknown; h?: unknown } | undefined;
        if (s && typeof s.w === 'number' && typeof s.h === 'number') this.screen = { w: s.w, h: s.h };
        return;
      }
      case 'arrived':
      case 'interrupted': {
        const w = this.walks.get(String(msg.walkId));
        if (!w) return;
        this.walks.delete(String(msg.walkId));
        clearTimeout(w.timer);
        const at = typeof msg.x === 'number' ? pct(msg.x) : '?';
        w.resolve(msg.t === 'arrived'
          ? `走到了屏幕横向 ${at} 处。`
          : msg.by === 'drag' ? `没走到:走到 ${at} 处时被${this.cfg.user}拎起来了。` : `没走到:走到 ${at} 处时换成了别的动作(${String(msg.by)})。`);
        return;
      }
      case 'answer': return this.onAnswer(msg);
      case 'text': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
        if (text) void this.push('desktop-pet.message', `desktop-pet.text`, `[打字] ${this.cfg.user}:${text}`, 'flush');
        return;
      }
      case 'touch': return this.onTouch(msg);
      case 'mic': {
        this.micState = { state: String(msg.state), detail: typeof msg.detail === 'string' ? msg.detail : null };
        return;
      }
      case 'prefs': return this.savePrefs(msg);
    }
  }

  private onPageGone(): void {
    this.log?.info('桌宠页面断开');
    for (const [id, w] of this.walks) { clearTimeout(w.timer); w.resolve('没走到:桌宠窗口断开了。'); this.walks.delete(id); }
    this.segmenter.flush();
    if (this.wasSpeaking) this.wasSpeaking = false;
  }

  private onAnswer(msg: PageMessage): void {
    const ask = this.ask;
    if (!ask || ask.id !== msg.askId) return;
    this.ask = null;
    const q = `「${ask.question}」`;
    if (msg.dismissed) {
      void this.push('desktop-pet.answer', 'desktop-pet.answer', `[回答] ${this.cfg.user}关掉了提问${q},没有作答。`, 'debounce');
      return;
    }
    const index = typeof msg.index === 'number' ? msg.index : null;
    const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
    const body = index !== null && ask.options[index] !== undefined
      ? `选了第 ${index + 1} 项「${ask.options[index]}」`
      : `自己写了:「${text}」`;
    void this.push('desktop-pet.answer', 'desktop-pet.answer', `[回答] ${this.cfg.user}回答${q}:${body}`, 'flush');
  }

  private onTouch(msg: PageMessage): void {
    if (!this.cfg.touch.enabled) return;
    const kind = String(msg.kind);
    if (kind === 'grab') return;
    if (kind === 'crash' && this.touch && (this.touch.kind === 'throw' || this.touch.kind === 'drop')) {
      this.touch.crashed = true;
      return;
    }
    if (this.touch && this.touch.kind === kind && kind !== 'throw' && kind !== 'drop') {
      this.touch.count++;
      this.touch.woke ||= msg.woke === true;
      clearTimeout(this.touch.timer);
      this.touch.timer = setTimeout(() => this.flushTouch(), TOUCH_MERGE_MS);
      return;
    }
    if (this.touch) this.flushTouch();
    this.touch = {
      kind, count: 1, woke: msg.woke === true, asleep: msg.asleep === true, crashed: false,
      x: typeof msg.x === 'number' ? msg.x : null,
      timer: setTimeout(() => this.flushTouch(), TOUCH_MERGE_MS),
    };
  }

  private flushTouch(): void {
    const t = this.touch;
    this.touch = null;
    if (!t) return;
    clearTimeout(t.timer);
    const u = this.cfg.user;
    let text: string;
    switch (t.kind) {
      case 'poke': text = t.woke ? `${u}把睡着的你戳醒了` : t.count > 1 ? `${u}戳了你 ${t.count} 下` : `${u}戳了你一下`; break;
      case 'pet': text = t.asleep ? `${u}摸了摸睡着的你` : t.count > 1 ? `${u}摸了你好几下` : `${u}摸了摸你的头`; break;
      case 'throw': text = `${u}把你拎起来甩了出去${t.crashed ? ',你重重落地,摔晕了一会儿' : ''}`; break;
      case 'drop': text = `${u}把你拎起来,放到了屏幕横向 ${t.x !== null && this.screen ? pct(t.x / this.screen.w) : '某'} 处${t.crashed ? ',你摔晕了一会儿' : ''}`; break;
      case 'crash': text = '你重重落地,摔晕了一会儿'; break;
      default: return;
    }
    void this.push('desktop-pet.touch', 'desktop-pet.touch', `[互动] ${text}`, this.cfg.touch.trigger);
  }

  private async push(type: string, senderKey: string, text: string, trigger: 'flush' | 'debounce' | 'piggyback'): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({ type, source: this.id, senderKey, ts: nowIso(this.opts.timezone), text }, { trigger });
    } catch (err) {
      this.log?.warn(`事件没能送出:${(err as Error).message}`);
    }
  }

  /* ---------- voice ---------- */

  private whisperLaunch(): { exe: string; model: string } | { missing: string } {
    const exe = this.cfg.asr.serverFile || this.store.whisper.executable();
    if (!exe) return { missing: '没有 whisper.cpp 服务程序:在语音输入面板安装,或在配置里指定' };
    const modelState = this.store.model(this.cfg.asr.model).state();
    const model = this.cfg.asr.modelFile || (modelState.phase === 'ready' ? modelState.path : '');
    if (!model) return { missing: `没有识别模型 ${WHISPER_MODELS[this.cfg.asr.model].file}:在语音输入面板下载` };
    return { exe, model };
  }

  async startVoiceBackend(): Promise<WhisperServerState | null> {
    if (!this.whisper) return null;
    await this.whisper.start();
    this.syncPrefs();
    return this.whisper.state();
  }

  private onAudio(frame: Int16Array): void {
    if (!this.cfg.asr.enabled || !this.micWanted()) return;
    for (const u of this.segmenter.push(frame)) {
      this.counts.utterances++;
      this.queue.push(u);
      this.server.sendPet({ t: 'listen', phase: 'transcribing' });
      void this.drain();
    }
    const speaking = this.segmenter.active;
    if (speaking && !this.wasSpeaking) this.server.sendPet({ t: 'listen', phase: 'start' });
    this.wasSpeaking = speaking;
    const now = Date.now();
    if (now - this.lastLevelAt >= 100) {
      this.lastLevelAt = now;
      this.voiceFrame({ type: 'level', level: this.segmenter.level, speaking });
    }
    this.schedulePack();
  }

  private async drain(): Promise<void> {
    if (this.transcribing) return;
    this.transcribing = true;
    try {
      while (this.queue.length) {
        const u = this.queue.shift()!;
        const res = await transcribe(u.pcm, SAMPLE_RATE, {
          baseUrl: this.cfg.asr.baseUrl, model: WHISPER_MODELS[this.cfg.asr.model].file, language: this.cfg.asr.language,
          timeoutMs: this.cfg.asr.timeoutMs, fetchImpl: this.opts.fetchImpl,
        });
        let text = res.text;
        if (this.cfg.asr.simplified) text = toSimplified(text);
        if (res.error || looksHallucinated(text)) {
          this.counts.dropped++;
          this.remember({ text: res.error ? `[失败] ${res.error}` : text, at: Date.now(), ms: res.ms, dropped: true });
          this.voiceFrame({ type: 'dropped', text: res.error ?? text, ms: res.ms });
          continue;
        }
        this.packer.add(text, Date.now());
        this.remember({ text, at: Date.now(), ms: res.ms });
        this.voiceFrame({ type: 'text', text, ms: res.ms });
        this.server.sendPet({ t: 'listen', phase: 'partial', text: this.pendingText(text) });
      }
    } finally {
      this.transcribing = false;
    }
    this.schedulePack();
  }

  private partial = '';
  private pendingText(add: string): string {
    this.partial = this.partial ? `${this.partial} ${add}` : add;
    return this.partial;
  }

  /** Delivers the packed text once nothing upstream is still open. */
  private schedulePack(): void {
    const hold = this.segmenter.active || this.transcribing || this.queue.length > 0 || this.segmenter.settleRemainingMs > 0;
    const text = this.packer.due(Date.now(), hold);
    if (text) {
      this.partial = '';
      this.listenOpen = false;
      this.counts.delivered++;
      this.server.sendPet({ t: 'listen', phase: 'heard', text });
      void this.push('desktop-pet.speech', 'desktop-pet.voice', `[语音] ${this.cfg.user}:${text}`, 'flush');
      return;
    }
    if (this.segmenter.active || this.transcribing || this.queue.length > 0) this.listenOpen = true;
    else if (!hold && !this.packer.pending && this.listenOpen) {
      // the episode ended with nothing worth delivering
      this.listenOpen = false;
      this.partial = '';
      this.server.sendPet({ t: 'listen', phase: 'none' });
    }
    if (this.packer.pending && !this.packTimer) {
      this.packTimer = setTimeout(() => { this.packTimer = null; this.schedulePack(); }, Math.max(50, this.segmenter.settleRemainingMs || 100));
    }
  }

  /** A listening episode is open on the page (bubble shown) and has not been closed yet. */
  private listenOpen = false;

  private remember(line: HeardLine): void {
    this.heard.push(line);
    if (this.heard.length > 50) this.heard.shift();
  }

  private voiceFrame(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame);
    for (const s of this.voiceSockets) if (s.open) s.send(text);
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      pet_say: (args) => this.say(args),
      pet_ask: (args) => this.askUser(args),
      pet_walk_to: (args) => this.walkTo(args),
      pet_act: (args) => this.act(args),
    };
    return DESKTOP_PET_TOOL_DECLS.map((decl) => ({ ...decl, handler: handlers[decl.name] }));
  }

  private notConnected(tool: string): ToolOutcome {
    const w = this.windowHost?.state();
    const why = w && w.phase !== 'running' && w.detail ? `(${w.detail})` : '';
    return { text: `[${tool} 没执行] 桌宠窗口没有连接${why},${this.cfg.user}看不到。`, failed: true };
  }

  private async say(args: Record<string, unknown>): Promise<ToolOutcome> {
    const script = typeof args.script === 'string' ? args.script : '';
    const { beats, dropped } = parseScript(script);
    if (!beats.some((b) => b.text || b.actions.length || b.anchors.length)) {
      return { text: '[pet_say 没执行] 脚本是空的。不想说话就不调用。', failed: true };
    }
    const id = nextId('s');
    if (!this.server.sendPet({ t: 'say', id, beats })) return this.notConnected('pet_say');
    const now = Date.now();
    const selfSec = estimateSeconds(beats);
    const waitSec = Math.max(0, (this.busyUntil - now) / 1000);
    this.busyUntil = Math.max(now, this.busyUntil) + selfSec * 1000;
    const replaced = this.ask ? `替换了还没回答的提问「${this.ask.question}」。` : '';
    if (this.ask) this.ask = null;
    const note = dropped.length ? `\n[执行参数] 不认识的标记已略过:${dropped.join('、')}。` : '';
    return { text: `${waitSec > .5 ? `已排队,前面还有约 ${Math.round(waitSec)} 秒` : '已开始显示'},这段约 ${Math.round(selfSec)} 秒。${replaced}${note}` };
  }

  private async askUser(args: Record<string, unknown>): Promise<ToolOutcome> {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const raw = Array.isArray(args.options) ? args.options : [];
    const options = raw.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim().slice(0, 40)).slice(0, 3);
    const allowOwn = args.allowOwnAnswer !== false;
    if (!question) return { text: '[pet_ask 没执行] question 是空的。', failed: true };
    if (options.length === 0 && !allowOwn) return { text: '[pet_ask 没执行] 没有选项,又不允许自己写,没法作答。', failed: true };
    const id = nextId('a');
    if (!this.server.sendPet({ t: 'ask', id, question, options, own: allowOwn })) return this.notConnected('pet_ask');
    const replaced = this.ask ? `替换了还没回答的上一个提问「${this.ask.question}」。` : '';
    this.ask = { id, question, options };
    const cut = raw.length > 3 ? '只显示了前 3 个选项。' : '';
    return { text: `已问出。${replaced}${cut}回答到了会以 [回答] 事件送达。` };
  }

  private async walkTo(args: Record<string, unknown>): Promise<ToolOutcome> {
    const run = args.run === true;
    const to = args.to;
    let target: number | 'cursor';
    if (typeof to === 'number' && Number.isFinite(to)) target = Math.max(0, Math.min(1, to));
    else if (typeof to === 'string') {
      const named: Record<string, number | 'cursor'> = { left: .05, center: .5, right: .95, cursor: 'cursor' };
      const n = Number(to);
      if (to in named) target = named[to];
      else if (to.trim() !== '' && Number.isFinite(n)) target = Math.max(0, Math.min(1, n));
      else return { text: `[pet_walk_to 没执行] to 应为 0–1 的数字或 left / center / right / cursor,收到 ${JSON.stringify(to)}。`, failed: true };
    } else return { text: '[pet_walk_to 没执行] 缺少 to。', failed: true };
    const walkId = nextId('w');
    if (!this.server.sendPet({ t: 'walk', id: walkId, to: target, run })) return this.notConnected('pet_walk_to');
    const text = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.walks.delete(walkId);
        resolve(`${WALK_TIMEOUT_MS / 1000} 秒内没有走到。`);
      }, WALK_TIMEOUT_MS);
      this.walks.set(walkId, { resolve, timer });
    });
    return { text };
  }

  private async act(args: Record<string, unknown>): Promise<ToolOutcome> {
    const list = Array.isArray(args.actions) ? args.actions : typeof args.actions === 'string' ? [args.actions] : [];
    const { actions, dropped } = parseActions(list);
    if (!actions.length) return { text: `[pet_act 没执行] 没有认得的动作${dropped.length ? `(${dropped.join('、')})` : ''}。`, failed: true };
    if (!this.server.sendPet({ t: 'act', id: nextId('c'), actions })) return this.notConnected('pet_act');
    const lasting = actions.filter((a) => a === 'sit' || a === 'sleep');
    const note = dropped.length ? `\n[执行参数] 不认识的动作已略过:${dropped.join('、')}。` : '';
    return { text: `开始依次做:${actions.join(' → ')}。${lasting.length ? `${lasting.join('、')} 会一直保持到下一个动作。` : ''}${note}` };
  }

  /* ---------- prompt ---------- */

  envPromptVars(): Record<string, string> {
    return {
      'pet.user': this.cfg.user,
      'pet.vocab': vocabTable(),
      'pet.voice': this.cfg.asr.enabled ? '开着' : '关着',
    };
  }

  /* ---------- console ---------- */

  console(language: Language = 'zh'): WorldConsoleDecl {
    const w = this.windowHost?.state();
    const v = this.whisper?.state();
    const lamps: WorldLamp[] = [
      {
        label: '桌宠窗口',
        state: this.server.petConnected ? 'online' : w?.phase === 'running' ? 'loading' : w?.phase === 'missing' || w?.phase === 'error' ? 'error' : 'offline',
        hint: this.server.petConnected ? '页面已连接' : w?.detail ?? '未打开',
      },
      {
        label: '语音识别',
        state: !this.cfg.asr.enabled ? 'offline' : v?.phase === 'running' || v?.phase === 'external' ? 'online' : v?.phase === 'starting' ? 'loading' : v?.phase === 'error' ? 'error' : 'offline',
        hint: v?.detail ?? v?.phase ?? '未启动',
      },
    ];
    return {
      label: language === 'en' ? 'Desktop pet' : '桌宠',
      lamps,
      panels: [...DESKTOP_PET_PANEL_DECLS],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => {
        if (panel !== 'voice') { socket.close('no stream'); return; }
        this.voiceSockets.add(socket);
        socket.onClose(() => this.voiceSockets.delete(socket));
      },
      links: this.server.port ? [{ label: '在浏览器里看桌宠', href: this.petUrl }, { label: '装扮', href: `${this.server.origin}/dress` }] : [],
      config: [DESKTOP_PET_CONFIG_GROUP, DESKTOP_PET_ASR_CONFIG_GROUP],
      promptDocs: [{
        key: `worlds.${DESKTOP_PET_ID}.envPrompt`,
        title: '桌宠环境',
        description: '描述桌宠的身体、四个工具与输入事件。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'pet.user', description: '对使用者的称呼' },
          { name: 'pet.vocab', description: '表情与动作词表', multiline: true },
          { name: 'pet.voice', description: '语音输入开着还是关着' },
        ],
      }],
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'pet') {
      switch (method) {
        case 'state': return this.petState();
        case 'openWindow': this.openWindow(); return this.petState();
        case 'closeWindow': await this.windowHost?.stop(); return this.petState();
        case 'installElectron': void this.store.electron.install(); return this.petState();
      }
    }
    if (panel === 'voice') {
      switch (method) {
        case 'state': return this.voiceState();
        case 'install': {
          const model = (typeof args[0] === 'string' && args[0] in WHISPER_MODELS ? args[0] : this.cfg.asr.model) as WhisperModel;
          if (model !== this.cfg.asr.model) this.opts.persist({ asr: { model } });
          void this.installVoice(model);
          return this.voiceState();
        }
        case 'start': await this.startVoiceBackend(); return this.voiceState();
        case 'stop': await this.whisper?.stop(); this.syncPrefs(); return this.voiceState();
        case 'setEnabled': this.savePrefs({ mic: args[0] === true }); return this.voiceState();
      }
    }
    throw new Error(`未知方法 ${panel}.${method}`);
  }

  /** Downloads what voice input still lacks, then starts the server. */
  async installVoice(model: WhisperModel = this.cfg.asr.model): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (!this.cfg.asr.serverFile && this.store.whisper.state().phase !== 'ready') jobs.push(this.store.whisper.install());
    if (!this.cfg.asr.modelFile && this.store.model(model).state().phase !== 'ready') jobs.push(this.store.model(model).install());
    await Promise.all(jobs);
    if (this.cfg.asr.enabled && this.cfg.asr.manageServer) {
      await this.whisper?.stop();
      await this.startVoiceBackend();
    }
  }

  petState(): Record<string, unknown> {
    return {
      connected: this.server.petConnected,
      url: this.server.port ? this.petUrl : null,
      dressUrl: this.server.port ? `${this.server.origin}/dress` : null,
      window: this.windowHost?.state() ?? null,
      electron: { ...this.store.electron.state(), supported: this.store.electron.supported },
      screen: this.screen,
    };
  }

  voiceState(): Record<string, unknown> {
    const models = Object.fromEntries(
      (Object.keys(WHISPER_MODELS) as WhisperModel[]).map((m) => [m, { ...this.store.model(m).state(), bytes: WHISPER_MODELS[m].bytes }]),
    ) as Record<string, ArtifactState & { bytes: number }>;
    return {
      enabled: this.cfg.asr.enabled,
      model: this.cfg.asr.model,
      server: this.whisper?.state() ?? null,
      runtime: { ...this.store.whisper.state(), supported: this.store.whisper.supported || !!this.cfg.asr.serverFile },
      models,
      mic: this.micState,
      level: this.segmenter.level,
      thresholdDb: this.cfg.asr.segment.thresholdDb,
      recent: this.heard.slice(-20),
      counts: { ...this.counts },
    };
  }
}

export const modelsDirFor = (root: string) => join(root, DESKTOP_PET_ID);
