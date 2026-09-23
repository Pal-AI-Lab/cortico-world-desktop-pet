/**
 * Managed downloads against a local file server: archive download and unpack, model
 * checksum rejection, and the `.partial` protocol. The pinned URLs are rewritten to the
 * local server through `fetchImpl`; nothing reaches the network.
 */
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RuntimeStore, WHISPER_RUNTIME, extract } from '../src/runtime/store.ts';

function zipOf(dir: string, out: string): void {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, ['-a', '-cf', out, '-C', dir, '.'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

async function fileServer(files: Record<string, Buffer>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('?')[0].split('/').pop() ?? '');
    hits.push(name);
    const body = files[name];
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': String(body.length) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const fetchImpl: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${u.pathname}`, init);
  };
  return { server, fetchImpl, hits };
}

describe.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')('runtime store', () => {
  it('downloads and unpacks the whisper.cpp archive, then finds its server executable', async () => {
    const stage = mkdtempSync(join(tmpdir(), 'pet-zip-'));
    mkdirSync(join(stage, 'Release'));
    writeFileSync(join(stage, 'Release', WHISPER_RUNTIME.executable), 'exe');
    const archive = join(mkdtempSync(join(tmpdir(), 'pet-arc-')), 'w.zip');
    zipOf(stage, archive);
    const asset = WHISPER_RUNTIME.assets[`${process.platform}-${process.arch}`];
    const { server, fetchImpl } = await fileServer({ [asset.file]: readFileSync(archive) });
    try {
      const root = mkdtempSync(join(tmpdir(), 'pet-rt-'));
      const store = new RuntimeStore({ runtimesRoot: () => root, modelsDir: () => join(root, 'models'), fetchImpl });
      expect(store.whisper.state().phase).toBe('absent');
      await store.whisper.install();
      expect(store.whisper.state()).toMatchObject({ phase: 'ready' });
      expect(store.whisper.executable()).toBe(join(root, 'whisper.cpp', WHISPER_RUNTIME.version, 'Release', WHISPER_RUNTIME.executable));
      expect(existsSync(`${store.whisper.dir}.partial`)).toBe(false);
      expect(JSON.parse(readFileSync(join(store.whisper.dir, 'cortico-runtime.json'), 'utf8'))).toMatchObject({ id: 'whisper.cpp', version: WHISPER_RUNTIME.version });
    } finally {
      server.close();
    }
  });

  it('rejects a model whose checksum does not match and leaves no file behind', async () => {
    const { server, fetchImpl } = await fileServer({ 'ggml-base-q5_1.bin': Buffer.from('not a model') });
    try {
      const root = mkdtempSync(join(tmpdir(), 'pet-rt-'));
      const models = join(root, 'models');
      mkdirSync(models, { recursive: true });
      const store = new RuntimeStore({ runtimesRoot: () => root, modelsDir: () => models, fetchImpl });
      await store.model('base-q5_1').install();
      const st = store.model('base-q5_1').state();
      expect(st.phase).toBe('error');
      expect(st.detail).toContain('校验不符');
      expect(readdirSync(models)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('reports an HTTP failure as an error state', async () => {
    const { server, fetchImpl } = await fileServer({});
    try {
      const root = mkdtempSync(join(tmpdir(), 'pet-rt-'));
      const store = new RuntimeStore({ runtimesRoot: () => root, modelsDir: () => join(root, 'm'), fetchImpl });
      await store.whisper.install();
      expect(store.whisper.state()).toMatchObject({ phase: 'error', detail: 'HTTP 404' });
      expect(existsSync(`${store.whisper.dir}.partial`)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('extract unpacks a zip with the system tar', async () => {
    const stage = mkdtempSync(join(tmpdir(), 'pet-zip-'));
    writeFileSync(join(stage, 'a.txt'), 'hello');
    const archive = join(mkdtempSync(join(tmpdir(), 'pet-arc-')), 'x.zip');
    zipOf(stage, archive);
    const out = mkdtempSync(join(tmpdir(), 'pet-out-'));
    await extract(archive, out);
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello');
  });
});
