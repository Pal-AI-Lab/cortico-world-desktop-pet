/**
 * The managed whisper.cpp server. It is started only when nothing answers at the configured
 * endpoint; an endpoint that already answers (a server started by hand, a hosted service)
 * is used as it is and never stopped from here.
 *
 * whisper-server has no health route, so any HTTP answer on the port counts as up. Once up it
 * gets half a second of silence, which moves model warm-up away from the first real sentence.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { transcribe } from './client.ts';

export type ServerPhase = 'stopped' | 'starting' | 'running' | 'external' | 'error';

export interface WhisperServerState {
  phase: ServerPhase;
  url: string;
  pid: number | null;
  detail: string | null;
}

export interface WhisperServerOptions {
  baseUrl: () => string;
  /** Resolved at start: executable and model file, or a reason they are missing. */
  launch: () => { exe: string; model: string } | { missing: string };
  language: () => string;
  threads: () => number;
  log: Logger;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const INFERENCE_PATH = '/v1/audio/transcriptions';

export class WhisperServer {
  private child: ChildProcess | null = null;
  private phase: ServerPhase = 'stopped';
  private detail: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: WhisperServerOptions) {}

  private get origin(): URL {
    return new URL(this.opts.baseUrl());
  }

  state(): WhisperServerState {
    return { phase: this.phase, url: this.opts.baseUrl(), pid: this.child?.pid ?? null, detail: this.detail };
  }

  /** Any HTTP answer at the endpoint's origin. */
  async reachable(): Promise<boolean> {
    try {
      await (this.opts.fetchImpl ?? fetch)(this.origin.origin + '/', { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.phase === 'running' || this.phase === 'external') return;
    if (await this.reachable()) {
      this.phase = 'external';
      this.detail = '端点已有服务在跑';
      return;
    }
    const launch = this.opts.launch();
    if ('missing' in launch) {
      this.phase = 'error';
      this.detail = launch.missing;
      return;
    }
    const url = this.origin;
    const lang = this.opts.language();
    const args = ['--host', url.hostname, '--port', url.port || '80', '-m', launch.model,
      '--inference-path', INFERENCE_PATH, '-l', lang && lang !== 'auto' ? lang : 'auto', '-mc', '0', '-nt', '-sns'];
    const threads = this.opts.threads();
    if (threads > 0) args.push('-t', String(threads));
    this.phase = 'starting';
    this.detail = null;
    let child: ChildProcess;
    try {
      child = spawn(launch.exe, args, { cwd: dirname(launch.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Windows reports an application-control block as a synchronous UNKNOWN
      this.phase = 'error';
      this.detail = `启动失败:${(err as Error).message}`;
      return;
    }
    this.child = child;
    const log = this.opts.log.child('whisper');
    const forward = (d: Buffer) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log.debug(line); };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', (err) => { this.phase = 'error'; this.detail = err.message; });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.phase !== 'stopped') { this.phase = 'error'; this.detail = `识别服务退出(退出码 ${code})`; }
    });
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.child !== child) return;
      if (await this.reachable()) {
        this.phase = 'running';
        await transcribe(new Int16Array(8000), 16000, { baseUrl: this.opts.baseUrl(), model: 'whisper', language: lang, timeoutMs: 60_000, fetchImpl: this.opts.fetchImpl });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.phase = 'error';
    this.detail = '识别服务在期限内没有应答';
    await this.stop();
    this.phase = 'error';
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (this.phase !== 'error') this.phase = 'stopped';
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
}
