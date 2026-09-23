/**
 * The talk key: a hotkey held or pressed anywhere on the desktop, read by polling
 * GetAsyncKeyState through koffi. Windows only; elsewhere, or when koffi does not load,
 * `watchHotkey` returns the reason instead of a watcher.
 *
 * A hotkey is key names joined by `+` (`RightCtrl`, `Ctrl+Space`, `F8`, `Mouse4`); it is down
 * while every named key is down.
 */

const NAMED: Record<string, number> = {
  Ctrl: 0x11, LeftCtrl: 0xa2, RightCtrl: 0xa3,
  Alt: 0x12, LeftAlt: 0xa4, RightAlt: 0xa5,
  Shift: 0x10, LeftShift: 0xa0, RightShift: 0xa1,
  Win: 0x5b, RightWin: 0x5c,
  Space: 0x20, Tab: 0x09, CapsLock: 0x14, Backquote: 0xc0, Enter: 0x0d,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Pause: 0x13, ScrollLock: 0x91,
  Mouse3: 0x04, Mouse4: 0x05, Mouse5: 0x06,
};

/** Virtual-key codes of `hotkey`, or null when a name is unknown. */
export function parseHotkey(hotkey: string): number[] | null {
  const parts = hotkey.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const codes: number[] = [];
  for (const p of parts) {
    let vk: number | undefined = NAMED[p];
    if (vk === undefined && /^[A-Z0-9]$/.test(p)) vk = p.charCodeAt(0);
    const fn = /^F([1-9]|1\d|2[0-4])$/.exec(p);
    if (vk === undefined && fn) vk = 0x6f + Number(fn[1]);
    if (vk === undefined) return null;
    codes.push(vk);
  }
  return codes;
}

export interface KeyWatcher {
  stop(): void;
}

/** Calls `onChange` on every press and release of the hotkey whose codes are `keys`. */
export async function watchHotkey(keys: number[], onChange: (down: boolean) => void, pollMs: number): Promise<KeyWatcher | string> {
  if (process.platform !== 'win32') return '按键收音只在 Windows 上可用';
  let getKey: (vk: number) => number;
  try {
    const koffi = (await import('koffi')).default;
    getKey = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int vKey)') as (vk: number) => number;
  } catch (err) {
    return `读不了键盘状态:${(err as Error).message}`;
  }
  let down = false;
  const timer = setInterval(() => {
    // the high bit is set while the key is down
    const now = keys.every((vk) => (getKey(vk) & 0x8000) !== 0);
    if (now === down) return;
    down = now;
    onChange(now);
  }, pollMs);
  return { stop: () => clearInterval(timer) };
}
