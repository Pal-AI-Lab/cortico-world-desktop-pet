import { describe, expect, it } from 'vitest';
import { parseHotkey } from '../src/asr/hotkey.ts';

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
