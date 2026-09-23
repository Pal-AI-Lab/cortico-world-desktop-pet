/**
 * Transcription client: one utterance of PCM in, one line of text out, over the
 * OpenAI-compatible `POST /audio/transcriptions` (multipart, field `file`). The managed
 * whisper.cpp server is started with `--inference-path /v1/audio/transcriptions` so it
 * answers the same route as any hosted endpoint.
 *
 * `language` is sent explicitly: left to guess, whisper decides from the first few hundred
 * milliseconds and a short Chinese sentence can come back as Japanese kana.
 */

export interface TranscribeOptions {
  /** e.g. http://127.0.0.1:8794/v1 */
  baseUrl: string;
  model: string;
  /** ISO 639-1; 'auto' lets the server decide. */
  language: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface TranscribeResult {
  text: string;
  ms: number;
  /** null on success. */
  error: string | null;
}

/** 16-bit mono PCM → WAV bytes (44-byte header + samples). */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const bytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

function textOf(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const json = JSON.parse(trimmed) as { text?: unknown };
    return typeof json.text === 'string' ? json.text : '';
  } catch {
    return trimmed;
  }
}

export async function transcribe(pcm: Int16Array, sampleRate: number, opts: TranscribeOptions): Promise<TranscribeResult> {
  const started = Date.now();
  const form = new FormData();
  form.append('file', new Blob([wavFromPcm16(pcm, sampleRate) as BlobPart], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', opts.model);
  form.append('response_format', 'json');
  // temperature 0: a few missing characters beat invented ones
  form.append('temperature', '0');
  if (opts.language && opts.language !== 'auto') form.append('language', opts.language);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs) });
    const body = await res.text();
    if (!res.ok) return { text: '', ms: Date.now() - started, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    return { text: textOf(body).trim(), ms: Date.now() - started, error: null };
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? `识别超时(${opts.timeoutMs}ms)` : (err as Error).message;
    return { text: '', ms: Date.now() - started, error: msg };
  }
}

/**
 * Output that is not speech. On pure noise whisper reliably produces high-frequency lines
 * from its training subtitles; they cannot be told apart from real speech by content, so
 * they are blocked by list. Letting one through means an event claims a sentence nobody said.
 */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^[\s。.,、!?!?…~-]*$/,
  /字幕|谢谢观看|请不吝点赞|订阅|转发|打赏|明镜与点点栏目/,
  /^(thank you|thanks for watching|subtitles by|you)[\s.!]*$/i,
  /^[\s]*\[.*\][\s]*$/,
  /^\(.*\)$/,
  /^[\s]*（.*）[\s]*$/,
];

export function looksHallucinated(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(t));
}
