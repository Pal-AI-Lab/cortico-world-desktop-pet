/**
 * Managed downloads: the whisper.cpp server, its ggml models, and the Electron runtime that
 * hosts the pet window. Every artifact is pinned to a version. Files land at
 * `<CORTICO_HOME>/runtimes/<id>/<version>/` and `<CORTICO_HOME>/models/desktop-pet/`, are
 * written to `.partial` first and renamed into place when complete; models are checked
 * against the SHA-256 their repository publishes.
 *
 * Archives are unpacked with the system `tar` (bsdtar on Windows and macOS reads zip too);
 * Linux zips go through `unzip`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadFile, type DownloadOptions } from './download.ts';
import type { WhisperModel } from '../config.ts';

export type Phase = 'absent' | 'working' | 'ready' | 'error';

export interface ArtifactState {
  phase: Phase;
  /** Where the artifact lives (a directory for runtimes, a file for models). */
  path: string;
  done: number;
  total: number | null;
  detail: string | null;
}

const platformKey = (): string => `${process.platform}-${process.arch}`;

export const WHISPER_RUNTIME = {
  id: 'whisper.cpp',
  version: 'b5130',
  assets: {
    'win32-x64': { file: 'whisper-bin-x64.zip', bytes: 8_573_270 },
    'win32-arm64': { file: 'whisper-bin-win-cpu-arm64.zip', bytes: 4_361_895 },
    'linux-x64': { file: 'whisper-bin-ubuntu-x64.tar.gz', bytes: 9_793_438 },
    'linux-arm64': { file: 'whisper-bin-ubuntu-arm64.tar.gz', bytes: 4_605_905 },
  } as Record<string, { file: string; bytes: number }>,
  url: (file: string) => `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/${file}`,
  executable: process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server',
} as const;

const WHISPER_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const WHISPER_MODELS: Record<WhisperModel, { file: string; bytes: number; sha256: string }> = {
  'base-q5_1': { file: 'ggml-base-q5_1.bin', bytes: 59_707_625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  'small-q5_1': { file: 'ggml-small-q5_1.bin', bytes: 190_085_487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574_041_195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
};
const modelUrl = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/${file}?download=true`;

export const ELECTRON_RUNTIME = {
  id: 'electron',
  version: '44.4.4',
  assets: {
    'win32-x64': { file: 'electron-v44.4.4-win32-x64.zip', bytes: 158_149_795 },
    'darwin-arm64': { file: 'electron-v44.4.4-darwin-arm64.zip', bytes: 130_390_806 },
    'linux-x64': { file: 'electron-v44.4.4-linux-x64.zip', bytes: 122_970_570 },
  } as Record<string, { file: string; bytes: number }>,
  url: (file: string) => `https://github.com/electron/electron/releases/download/v44.4.4/${file}`,
  executable: process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron' : 'electron',
} as const;

/** Depth-first search for a file name under `dir`. */
export function findFile(dir: string, name: string, depth = 5): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
    const hit = findFile(join(dir, entry.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${cmd} 退出码 ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

export async function extract(archive: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  if (process.platform === 'win32') {
    // bsdtar ships with Windows 10+; GNU tar earlier on PATH (Git's) cannot read zip
    const tar = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await run(tar, ['-xf', archive, '-C', into], into);
  } else if (archive.endsWith('.zip') && process.platform === 'linux') {
    await run('unzip', ['-q', '-o', archive, '-d', into], into);
  } else {
    await run('tar', ['-xf', archive, '-C', into], into);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

interface Job { state: ArtifactState; promise: Promise<void> | null }

/** Tracks one runtime directory: present when its executable is found inside. */
class RuntimeSlot {
  private job: Job;
  constructor(
    private readonly root: () => string,
    private readonly spec: typeof WHISPER_RUNTIME | typeof ELECTRON_RUNTIME,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.job = { state: { phase: 'absent', path: '', done: 0, total: null, detail: null }, promise: null };
  }

  get dir(): string {
    return join(this.root(), this.spec.id, this.spec.version);
  }

  get supported(): boolean {
    return platformKey() in this.spec.assets;
  }

  /** The executable inside the installed runtime, or null. */
  executable(): string | null {
    if (process.platform === 'darwin' && this.spec.id === 'electron') {
      const app = join(this.dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
      return existsSync(app) ? app : null;
    }
    return findFile(this.dir, this.spec.executable);
  }

  state(): ArtifactState {
    if (this.job.promise) return { ...this.job.state };
    const exe = this.executable();
    if (exe) return { phase: 'ready', path: this.dir, done: 0, total: null, detail: null };
    return { ...this.job.state, phase: this.job.state.phase === 'error' ? 'error' : 'absent', path: this.dir };
  }

  install(): Promise<void> {
    if (this.job.promise) return this.job.promise;
    const asset = this.spec.assets[platformKey()];
    if (!asset) {
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: `没有 ${platformKey()} 的预编译包` };
      return Promise.resolve();
    }
    this.job.state = { phase: 'working', path: this.dir, done: 0, total: asset.bytes, detail: `下载 ${asset.file}` };
    const partial = `${this.dir}.partial`;
    const work = (async () => {
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial, { recursive: true });
      const archive = join(partial, asset.file);
      const opts: DownloadOptions = { fetchImpl: this.fetchImpl, onProgress: (done, total) => { this.job.state.done = done; this.job.state.total = total ?? asset.bytes; } };
      await downloadFile(this.spec.url(asset.file), archive, opts);
      this.job.state.detail = '解压';
      await extract(archive, partial);
      rmSync(archive, { force: true });
      writeFileSync(join(partial, 'cortico-runtime.json'), JSON.stringify({ id: this.spec.id, version: this.spec.version, source: this.spec.url(asset.file) }, null, 2));
      rmSync(this.dir, { recursive: true, force: true });
      renameSync(partial, this.dir);
      this.job.state = { phase: 'ready', path: this.dir, done: asset.bytes, total: asset.bytes, detail: null };
    })().catch((err: Error) => {
      rmSync(partial, { recursive: true, force: true });
      this.job.state = { phase: 'error', path: this.dir, done: 0, total: null, detail: err.message };
    }).finally(() => { this.job.promise = null; });
    this.job.promise = work;
    return work;
  }
}

/** Tracks one model file: present when the file exists at its full size. */
class ModelSlot {
  private job: Job;
  constructor(private readonly dir: () => string, private readonly model: WhisperModel, private readonly fetchImpl?: typeof fetch) {
    this.job = { state: { phase: 'absent', path: '', done: 0, total: null, detail: null }, promise: null };
  }

  get path(): string {
    return join(this.dir(), WHISPER_MODELS[this.model].file);
  }

  state(): ArtifactState {
    if (this.job.promise) return { ...this.job.state };
    const spec = WHISPER_MODELS[this.model];
    if (existsSync(this.path) && statSync(this.path).size === spec.bytes) return { phase: 'ready', path: this.path, done: spec.bytes, total: spec.bytes, detail: null };
    return { ...this.job.state, phase: this.job.state.phase === 'error' ? 'error' : 'absent', path: this.path };
  }

  install(): Promise<void> {
    if (this.job.promise) return this.job.promise;
    const spec = WHISPER_MODELS[this.model];
    const partial = `${this.path}.partial`;
    this.job.state = { phase: 'working', path: this.path, done: 0, total: spec.bytes, detail: `下载 ${spec.file}` };
    const work = (async () => {
      await downloadFile(modelUrl(spec.file), partial, { fetchImpl: this.fetchImpl, onProgress: (done, total) => { this.job.state.done = done; this.job.state.total = total ?? spec.bytes; } });
      this.job.state.detail = '校验';
      const sum = await sha256File(partial);
      if (sum !== spec.sha256) throw new Error(`${spec.file} 校验不符:${sum}`);
      renameSync(partial, this.path);
      this.job.state = { phase: 'ready', path: this.path, done: spec.bytes, total: spec.bytes, detail: null };
    })().catch((err: Error) => {
      rmSync(partial, { force: true });
      this.job.state = { phase: 'error', path: this.path, done: 0, total: null, detail: err.message };
    }).finally(() => { this.job.promise = null; });
    this.job.promise = work;
    return work;
  }
}

export interface RuntimeStoreOptions {
  runtimesRoot: () => string;
  modelsDir: () => string;
  fetchImpl?: typeof fetch;
}

export class RuntimeStore {
  readonly whisper: RuntimeSlot;
  readonly electron: RuntimeSlot;
  private readonly models = new Map<WhisperModel, ModelSlot>();

  constructor(private readonly opts: RuntimeStoreOptions) {
    this.whisper = new RuntimeSlot(opts.runtimesRoot, WHISPER_RUNTIME, opts.fetchImpl);
    this.electron = new RuntimeSlot(opts.runtimesRoot, ELECTRON_RUNTIME, opts.fetchImpl);
  }

  model(id: WhisperModel): ModelSlot {
    let slot = this.models.get(id);
    if (!slot) {
      slot = new ModelSlot(this.opts.modelsDir, id, this.opts.fetchImpl);
      this.models.set(id, slot);
    }
    return slot;
  }
}
