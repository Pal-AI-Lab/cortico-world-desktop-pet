/**
 * Windows' own speech recognizer: SAPI dictation through System.Speech, in one long-lived
 * PowerShell process (`system-sapi.ps1`). A sentence is streamed while it is spoken: its
 * audio goes in frame by frame and the text heard so far comes back as it grows, so the pet
 * shows what it hears before the sentence ends.
 *
 * Nothing to download: every Windows has System.Speech, and a Chinese Windows has the zh-CN
 * recognizer. It is less accurate than whisper.cpp's small model, which stays the upgrade.
 *
 * The script goes in through `-EncodedCommand`, so neither the execution policy nor the
 * console code page touches it; its output escapes everything outside ASCII for the same reason.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';
import type { TranscribeResult } from './client.ts';

export type SystemPhase = 'stopped' | 'starting' | 'running' | 'error';

export interface SystemRecognizerState {
  phase: SystemPhase;
  /** What the panel shows where the whisper server shows its URL. */
  url: string;
  pid: number | null;
  detail: string | null;
}

export interface SystemRecognizerOptions {
  /** ISO 639-1 or 'auto'; a change restarts the process before the next sentence. */
  language: () => string;
  timeoutMs: () => number;
  log: Logger;
  /** Starts the helper; tests pass a fake. */
  spawnImpl?: typeof spawn;
}

/** One sentence being heard: frames go in while it is spoken, the text comes back after `end`. */
export interface SystemSentence {
  write(frame: Int16Array): void;
  end(): Promise<TranscribeResult>;
}

const SCRIPT_FILE = fileURLToPath(new URL('./system-sapi.ps1', import.meta.url));
/** How long PowerShell gets to compile the helper and open the recognizer. */
const READY_TIMEOUT_MS = 30_000;
/** Samples per `A` line when a finished sentence is streamed in at once. */
const CHUNK = 1600;

/** Available at all: Windows only. */
export const systemRecognizerSupported = (): boolean => process.platform === 'win32';

const FATAL: Record<string, (lang: string) => string> = {
  'system-speech': () => '系统语音组件 System.Speech 加载不了',
  'no-recognizer': (lang) => `系统里没有${lang === 'auto' ? '' : `「${lang}」的`}语音识别器:在 Windows 设置 → 时间和语言 → 语言里给该语言装上「语音识别」`,
};

function powershellExe(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

interface OpenSentence {
  onPartial: (text: string) => void;
  resolve: (r: TranscribeResult) => void;
  /** When the sentence ended: the reported time is what recognition took after that. */
  endedAt: number;
  timer: NodeJS.Timeout | null;
}

export class SystemRecognizer {
  private child: ChildProcess | null = null;
  private phase: SystemPhase = 'stopped';
  private detail: string | null = null;
  private culture = '';
  private language = '';
  private starting: Promise<void> | null = null;
  private readonly open = new Map<number, OpenSentence>();
  private nextId = 1;

  constructor(private readonly opts: SystemRecognizerOptions) {}

  state(): SystemRecognizerState {
    const url = this.culture ? `Windows 语音识别(${this.culture})` : 'Windows 语音识别';
    return { phase: this.phase, url, pid: this.child?.pid ?? null, detail: this.detail };
  }

  /** Running, in the configured language, and able to take a sentence now. */
  get ready(): boolean {
    return this.phase === 'running' && this.language === (this.opts.language() || 'auto') && !!this.child?.stdin?.writable;
  }

  /** Started (or failed) for another language than the configured one. */
  get languageChanged(): boolean {
    return this.language !== '' && this.phase !== 'starting' && this.language !== (this.opts.language() || 'auto');
  }

  /** Worth starting now: not ready, and not failed for the language still configured. */
  private get restartable(): boolean {
    return !this.ready && (this.phase !== 'error' || this.languageChanged);
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.ready) return;
    if (this.child) await this.stop();
    if (!systemRecognizerSupported()) {
      this.phase = 'error';
      this.detail = '系统语音识别只在 Windows 上可用';
      return;
    }
    const language = this.opts.language() || 'auto';
    this.language = language;
    this.phase = 'starting';
    this.detail = null;
    const encoded = Buffer.from(readFileSync(SCRIPT_FILE, 'utf8'), 'utf16le').toString('base64');
    let child: ChildProcess;
    try {
      child = (this.opts.spawnImpl ?? spawn)(powershellExe(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PET_ASR_LANGUAGE: language, PET_ASR_TIMEOUT_MS: String(this.opts.timeoutMs()) },
      });
    } catch (err) {
      this.phase = 'error';
      this.detail = `启动失败:${(err as Error).message}`;
      return;
    }
    this.child = child;
    const log = this.opts.log.child('sapi');
    child.stderr?.on('data', (d: Buffer) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log.debug(line); });
    // a helper that died mid-write must not take the World down with an EPIPE
    child.stdin?.on('error', (err) => log.debug(`stdin: ${err.message}`));
    let ready: (ok: boolean) => void = () => {};
    const readyP = new Promise<boolean>((r) => { ready = r; });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { log.debug(line); return; }
      if (msg.ready) {
        this.culture = typeof msg.culture === 'string' ? msg.culture : '';
        this.phase = 'running';
        log.info(`系统语音识别已就绪:${this.culture} ${typeof msg.name === 'string' ? msg.name : ''}`);
        ready(true);
      } else if (typeof msg.fatal === 'string') {
        this.phase = 'error';
        this.detail = FATAL[msg.fatal]?.(language) ?? msg.fatal;
        ready(false);
      } else this.answer(msg);
    });
    child.on('error', (err) => { this.phase = 'error'; this.detail = err.message; ready(false); });
    child.on('exit', (code) => {
      ready(false);
      if (this.child !== child) return;
      this.child = null;
      this.failAll('系统语音识别进程退出了');
      if (this.phase !== 'stopped' && this.phase !== 'error') { this.phase = 'error'; this.detail = `系统语音识别进程退出(退出码 ${code})`; }
    });
    const timer = setTimeout(() => ready(false), READY_TIMEOUT_MS);
    const ok = await readyP;
    clearTimeout(timer);
    if (!ok && this.child === child) {
      const detail = (this.phase as SystemPhase) === 'error' ? this.detail : '系统语音识别在期限内没有就绪';
      await this.stop();
      this.phase = 'error';
      this.detail = detail;
    }
  }

  /**
   * Starts hearing a sentence of 16 kHz mono audio, or returns null when the recognizer is not
   * ready. A stopped one, or one set to another language, is started then for later sentences;
   * one that failed for this language waits to be started again, so a missing recognizer is not
   * retried per sentence.
   * `onPartial` gets the whole text so far.
   */
  sentence(onPartial: (text: string) => void = () => {}): SystemSentence | null {
    if (!this.ready) { if (this.restartable) void this.start(); return null; }
    const stdin = this.child!.stdin!;
    const id = this.nextId++;
    const done = new Promise<TranscribeResult>((resolve) => {
      this.open.set(id, { onPartial, resolve, endedAt: 0, timer: null });
    });
    let ended = false;
    stdin.write(`B ${id}\n`);
    return {
      write: (frame) => {
        if (ended || !stdin.writable) return;
        stdin.write(`A ${Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64')}\n`);
      },
      end: () => {
        if (ended) return done;
        ended = true;
        const o = this.open.get(id);
        if (o) {
          o.endedAt = Date.now();
          // past its own timeout the helper is stuck; a new one starts for a later sentence
          o.timer = setTimeout(() => { void this.stop(); }, this.opts.timeoutMs() + 5000);
          if (stdin.writable) stdin.write('E\n');
        }
        return done;
      },
    };
  }

  /** One finished sentence, streamed in as fast as it goes. */
  async transcribe(pcm: Int16Array): Promise<TranscribeResult> {
    const started = Date.now();
    if (this.restartable) await this.start();
    const s = this.sentence();
    if (!s) return { text: '', ms: Date.now() - started, error: this.detail ?? '系统语音识别没有运行' };
    for (let at = 0; at < pcm.length; at += CHUNK) s.write(pcm.subarray(at, at + CHUNK));
    return s.end();
  }

  private answer(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const o = this.open.get(id);
    if (!o) return;
    if (typeof msg.partial === 'string') { o.onPartial(msg.partial.trim()); return; }
    this.open.delete(id);
    if (o.timer) clearTimeout(o.timer);
    const ms = o.endedAt ? Date.now() - o.endedAt : 0;
    if (typeof msg.error === 'string') o.resolve({ text: '', ms, error: msg.error === 'timeout' ? `识别超时(${this.opts.timeoutMs()}ms)` : msg.error });
    else o.resolve({ text: typeof msg.text === 'string' ? msg.text.trim() : '', ms, error: null });
  }

  private failAll(reason: string): void {
    for (const o of this.open.values()) {
      if (o.timer) clearTimeout(o.timer);
      o.resolve({ text: '', ms: o.endedAt ? Date.now() - o.endedAt : 0, error: reason });
    }
    this.open.clear();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (this.phase !== 'error') this.phase = 'stopped';
    this.failAll('系统语音识别已停止');
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    // closing stdin ends the helper's read loop; a stuck one is killed
    child.stdin?.end();
    const quit = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
    if (!quit) child.kill();
  }
}
