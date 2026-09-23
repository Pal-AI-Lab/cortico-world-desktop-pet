import { describe, expect, it } from 'vitest';
import { hotkeyLabel, macReadable, parseHotkey } from '../src/asr/hotkey.ts';

describe('parseHotkey', () => {
  it('reads modifiers, letters, digits, function keys and mouse side buttons', () => {
    expect(parseHotkey('Ctrl+Space')).toEqual([0x11, 0x20]);
    expect(parseHotkey('RightAlt+Q')).toEqual([0xa5, 0x51]);
    expect(parseHotkey('F8')).toEqual([0x77]);
    expect(parseHotkey('F24')).toEqual([0x87]);
    expect(parseHotkey('7')).toEqual([0x37]);
    expect(parseHotkey('Mouse4')).toEqual([0x05]);
  });

  it('rejects unknown names and an empty key', () => {
    expect(parseHotkey('Hyper')).toBeNull();
    expect(parseHotkey('F25')).toBeNull();
    expect(parseHotkey('')).toBeNull();
  });
});

describe('hotkeyLabel', () => {
  it('names keys the way the platform keyboard prints them', () => {
    expect(hotkeyLabel('RightCtrl', 'win32')).toBe('右 Ctrl');
    expect(hotkeyLabel('RightAlt', 'darwin')).toBe('右 Option');
    expect(hotkeyLabel('Win+Space', 'darwin')).toBe('Command + Space');
  });
});

describe('the Mac key table', () => {
  it('covers every key a hotkey can name except the Windows-only ones', () => {
    const names = ['Ctrl', 'RightCtrl', 'Alt', 'RightAlt', 'Shift', 'Win', 'RightWin', 'Space', 'Tab', 'Enter', 'Backquote', 'Mouse4', 'F1', 'F12', 'A', 'Z', '0', '9'];
    for (const n of names) expect(parseHotkey(n)!.every(macReadable), n).toBe(true);
    // no Pause, Scroll Lock or F21–F24 on a Mac keyboard
    for (const n of ['Pause', 'ScrollLock', 'F21']) expect(parseHotkey(n)!.every(macReadable), n).toBe(false);
  });
});
