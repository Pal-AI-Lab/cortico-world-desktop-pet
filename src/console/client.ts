/**
 * Console panels for the desktop pet: `pet` (window, dressing, window runtime) and `voice`
 * (whisper.cpp server, model downloads, microphone level, recognized lines). Data goes
 * through `ctx.invoke`, the level meter through `ctx.stream('voice')`.
 */
import type { ConsoleClientBundle, ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface Artifact { phase: 'absent' | 'working' | 'ready' | 'error'; path: string; done: number; total: number | null; detail: string | null }
interface PetState {
  connected: boolean;
  url: string | null;
  dressUrl: string | null;
  window: { phase: string; pid: number | null; source: string | null; detail: string | null } | null;
  electron: Artifact & { supported: boolean };
  screen: { w: number; h: number } | null;
}
interface VoiceState {
  enabled: boolean;
  model: string;
  server: { phase: string; url: string; pid: number | null; detail: string | null } | null;
  runtime: Artifact & { supported: boolean };
  models: Record<string, Artifact & { bytes: number }>;
  mic: { state: string; detail: string | null };
  input: {
    mode: MicMode;
    hotkey: string;
    deviceId: string;
    /** `always` while the talk key cannot be read */
    effectiveMode: MicMode;
    hotkeyProblem: string | null;
    open: boolean;
    devices: Array<{ id: string; label: string }>;
  };
  level: number;
  thresholdDb: number;
  recent: Array<{ text: string; at: number; ms: number; dropped?: boolean }>;
  counts: { utterances: number; delivered: number; dropped: number };
}

type MicMode = 'hold' | 'toggle' | 'always';
const MODES: Record<MicMode, string> = { hold: '按住说话键时收音', toggle: '按一下说话键开始,再按一下停', always: '一直收音' };

/** `KeyboardEvent.code` → the key names `src/asr/hotkey.ts` reads. */
const CODE_KEYS: Record<string, string> = {
  ControlLeft: 'LeftCtrl', ControlRight: 'RightCtrl', AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', MetaLeft: 'Win', MetaRight: 'RightWin',
  Space: 'Space', Tab: 'Tab', CapsLock: 'CapsLock', Backquote: 'Backquote', Enter: 'Enter', Insert: 'Insert',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause', ScrollLock: 'ScrollLock',
};
const keyOfCode = (code: string): string | null =>
  CODE_KEYS[code] ?? (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digitd$/.test(code) ? code.slice(5) : /^Fd{1,2}$/.test(code) ? code : null);
const KEY_LABELS: Record<string, string> = {
  LeftCtrl: '左 Ctrl', RightCtrl: '右 Ctrl', LeftAlt: '左 Alt', RightAlt: '右 Alt', LeftShift: '左 Shift', RightShift: '右 Shift',
  RightWin: '右 Win', Backquote: '`', Mouse3: '鼠标中键', Mouse4: '鼠标侧键 4', Mouse5: '鼠标侧键 5',
};
const hotkeyLabel = (hotkey: string) => hotkey.split('+').map((k) => KEY_LABELS[k] ?? k).join(' + ');

const MB = (n: number) => `${Math.round(n / 1048576)} MB`;
const progress = (a: Artifact) => (a.total ? `${Math.round((a.done / a.total) * 100)}%` : MB(a.done));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function statusRow(ctx: ConsolePanelContext, name: string) {
  const { ui } = ctx;
  const row = ui.h('div', 'mountrow');
  const dot = ui.h('span', 'navdot');
  const state = ui.h('span', 'mstate', '—');
  const detail = ui.h('span', 'mdetail');
  const acts = ui.h('span', 'macts');
  row.append(dot, ui.h('span', 'mname', name), state, detail, acts);
  return {
    row, acts,
    set(text: string, tone: 'on' | 'off' | 'busy' | 'bad', more = '') {
      state.textContent = text;
      detail.textContent = more;
      dot.className = `navdot ${tone === 'on' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'busy' ? 'warn' : ''}`;
    },
  };
}

const petPanel: ConsolePanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '桌宠', en: 'pet' });
    root.appendChild(card.el);
    const s = card.body;
    const msg = ui.msgline('');

    const win = statusRow(ctx, '桌宠窗口');
    const btnOpen = ui.button('打开窗口', { size: 'sm', variant: 'primary' });
    const btnClose = ui.button('关闭窗口', { size: 'sm' });
    win.acts.append(btnClose, btnOpen);

    const rt = statusRow(ctx, '窗口运行时');
    const btnInstall = ui.button('安装', { size: 'sm', variant: 'primary' });
    rt.acts.append(btnInstall);

    const links = ui.rowbar();
    const open = ui.h('a', 'btn sm', '在浏览器里看');
    open.target = '_blank'; open.rel = 'noopener';
    links.append(open, msg);

    const frameWrap = ui.h('div', 'pet-dressframe');
    const frame = ui.h('iframe');
    frame.title = '装扮';
    frameWrap.append(frame);

    s.append(win.row, rt.row, links, ui.section('装扮', '改动会立刻保存,并同步到桌宠窗口'), frameWrap);

    let st: PetState | null = null;
    const render = (next: PetState) => {
      st = next;
      const w = next.window;
      if (next.connected) win.set('已连接', 'on');
      else if (w?.phase === 'running') win.set('启动中', 'busy');
      else win.set(w?.phase === 'missing' || w?.phase === 'error' ? '打不开' : '未打开', w?.phase === 'missing' || w?.phase === 'error' ? 'bad' : 'off', w?.detail ?? '');
      btnOpen.disabled = w?.phase === 'running';
      btnClose.disabled = w?.phase !== 'running';
      const e = next.electron;
      if (w?.source && w.source !== e.path && e.phase !== 'ready') rt.set('用外部程序', 'on', w.source);
      else if (e.phase === 'ready') rt.set('已安装', 'on', e.path);
      else if (e.phase === 'working') rt.set(`下载中 ${progress(e)}`, 'busy', e.detail ?? '');
      else if (e.phase === 'error') rt.set('安装失败', 'bad', e.detail ?? '');
      else rt.set(e.supported ? '未安装' : '本平台没有预编译包', 'off', e.supported ? 'Electron 44.4.4,约 150 MB' : '');
      btnInstall.hidden = e.phase === 'ready' || !e.supported;
      btnInstall.disabled = e.phase === 'working';
      if (next.url) open.href = next.url;
      if (next.dressUrl && frame.dataset.src !== next.dressUrl) {
        frame.dataset.src = next.dressUrl;
        frame.src = next.dressUrl;
      }
    };
    const refresh = async () => { try { render(await ctx.invoke<PetState>('state')); } catch (err) { msg.textContent = errText(err); } };
    const call = (method: string) => async () => {
      try { render(await ctx.invoke<PetState>(method)); } catch (err) { msg.textContent = errText(err); }
    };
    btnOpen.addEventListener('click', call('openWindow'));
    btnClose.addEventListener('click', call('closeWindow'));
    btnInstall.addEventListener('click', call('installElectron'));
    void refresh();
    ctx.interval(() => void refresh(), 1500);
  },
};

const FLOOR_DB = -60;
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));

const voicePanel: ConsolePanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const card = ui.sheet({ title: '语音输入', en: 'voice' });
    root.appendChild(card.el);
    const s = card.body;
    const msg = ui.msgline('');

    const enabled = ui.checkbox('听麦克风', { onChange: (on: boolean) => void call('setEnabled', [on])() });
    const bar = ui.rowbar();
    bar.append(enabled.el, msg);

    const srv = statusRow(ctx, '识别服务');
    const btnStart = ui.button('启动', { size: 'sm', variant: 'primary' });
    const btnStop = ui.button('停止', { size: 'sm' });
    srv.acts.append(btnStop, btnStart);

    const rt = statusRow(ctx, 'whisper.cpp');
    const modelSel = ui.select();
    const btnInstall = ui.button('下载并启动', { size: 'sm', variant: 'primary' });
    rt.acts.append(modelSel, btnInstall);

    const micRow = statusRow(ctx, '麦克风');
    const deviceSel = ui.select();
    micRow.acts.append(deviceSel);

    const modeRow = statusRow(ctx, '收音方式');
    const modeSel = ui.select();
    modeSel.replaceChildren(...(Object.keys(MODES) as MicMode[]).map((m) => { const o = ui.h('option', null, MODES[m]); o.value = m; return o; }));
    const keyBtn = ui.button('', { size: 'sm' });
    modeRow.acts.append(modeSel, keyBtn);

    const meter = ui.h('div', 'pet-meter');
    const fill = ui.h('div', 'pet-meterfill');
    const mark = ui.h('div', 'pet-metermark');
    meter.append(fill, mark);

    const log = ui.log({ max: 100 });
    s.append(bar, srv.row, rt.row, micRow.row, modeRow.row, meter, ui.section('识别结果', '划掉的是太短或疑似幻觉、没有发出去的'), log.el);

    let st: VoiceState | null = null;
    let seen = 0;
    const render = (next: VoiceState) => {
      st = next;
      enabled.setChecked(next.enabled);
      const sv = next.server;
      if (!sv) srv.set('—', 'off');
      else if (sv.phase === 'running') srv.set('运行中', 'on', sv.url);
      else if (sv.phase === 'external') srv.set('外部服务', 'on', sv.url);
      else if (sv.phase === 'starting') srv.set('启动中', 'busy', sv.url);
      else if (sv.phase === 'error') srv.set('出错', 'bad', sv.detail ?? '');
      else srv.set('已停止', 'off', sv.url);
      btnStart.disabled = sv?.phase === 'running' || sv?.phase === 'starting';
      btnStop.disabled = sv?.phase !== 'running';

      const keys = Object.keys(next.models);
      if (modelSel.options.length !== keys.length) {
        modelSel.replaceChildren(...keys.map((k) => { const o = ui.h('option', null, `${k}(${MB(next.models[k].bytes)})`); o.value = k; return o; }));
      }
      if (document.activeElement !== modelSel) modelSel.value = next.model;
      const r = next.runtime, m = next.models[modelSel.value] ?? next.models[next.model];
      const busy = r.phase === 'working' || m?.phase === 'working';
      if (busy) rt.set('下载中', 'busy', [r.phase === 'working' ? `程序 ${progress(r)}` : '', m?.phase === 'working' ? `模型 ${progress(m)}` : ''].filter(Boolean).join(' · '));
      else if (r.phase === 'error' || m?.phase === 'error') rt.set('下载失败', 'bad', r.detail ?? m?.detail ?? '');
      else if (r.phase === 'ready' && m?.phase === 'ready') rt.set('已就绪', 'on', m.path);
      else rt.set(r.supported ? '缺文件' : '本平台没有预编译包', 'off', r.supported ? [r.phase !== 'ready' ? '程序 8 MB' : '', m?.phase !== 'ready' ? `模型 ${MB(m?.bytes ?? 0)}` : ''].filter(Boolean).join(' + ') : '在配置里指定 whisper-server 程序');
      btnInstall.disabled = busy;
      btnInstall.hidden = r.phase === 'ready' && m?.phase === 'ready';

      const mic = next.mic;
      micRow.set({ on: '收音中', off: '没在收', denied: '被拒绝', error: '出错' }[mic.state] ?? mic.state, mic.state === 'on' ? 'on' : mic.state === 'off' ? 'off' : 'bad', mic.detail ?? '');
      const input = next.input;
      const choices = [{ id: '', label: '系统默认' }, ...input.devices];
      if (input.deviceId && !choices.some((d) => d.id === input.deviceId)) choices.push({ id: input.deviceId, label: '之前选的设备(现在找不到)' });
      if (deviceSel.dataset.list !== JSON.stringify(choices)) {
        deviceSel.dataset.list = JSON.stringify(choices);
        deviceSel.replaceChildren(...choices.map((d, i) => { const o = ui.h('option', null, d.label || `麦克风 ${i}`); o.value = d.id; return o; }));
      }
      if (document.activeElement !== deviceSel) deviceSel.value = input.deviceId;
      if (document.activeElement !== modeSel) modeSel.value = input.mode;
      if (!capturing) keyBtn.textContent = `说话键:${hotkeyLabel(input.hotkey)}`;
      keyBtn.hidden = input.mode === 'always';
      const how = input.effectiveMode === 'hold' ? `按住 ${hotkeyLabel(input.hotkey)} 说话`
        : input.effectiveMode === 'toggle' ? `按 ${hotkeyLabel(input.hotkey)} 开关收音` : '一直收音';
      modeRow.set(input.open ? '正在收音' : '等说话键', input.open ? 'on' : 'off', input.hotkeyProblem ? `${input.hotkeyProblem},改为一直收音` : how);
      // the loudness threshold only decides where speech starts when the key is not held down
      mark.hidden = input.effectiveMode === 'hold';
      mark.style.left = `${meterPct(next.thresholdDb)}%`;
      for (const line of next.recent) {
        if (line.at <= seen) continue;
        seen = line.at;
        const el = log.append(line.text, line.dropped ? 'dim' : 'plain');
        if (line.dropped) el.style.textDecoration = 'line-through';
      }
    };
    const refresh = async () => { try { render(await ctx.invoke<VoiceState>('state')); } catch (err) { msg.textContent = errText(err); } };
    const call = (method: string, args: unknown[] = []) => async () => {
      try { render(await ctx.invoke<VoiceState>(method, args)); msg.textContent = ''; } catch (err) { msg.textContent = errText(err); }
    };
    btnStart.addEventListener('click', call('start'));
    btnStop.addEventListener('click', call('stop'));
    btnInstall.addEventListener('click', () => void call('install', [modelSel.value])());
    modeSel.addEventListener('change', () => void call('setMic', [{ mode: modeSel.value }])());
    deviceSel.addEventListener('change', () => void call('setMic', [{ deviceId: deviceSel.value }])());

    // The talk key is captured on the first release: every key down until then is part of it.
    let capturing = false;
    const held: string[] = [];
    const finishCapture = (hotkey: string | null) => {
      capturing = false;
      held.length = 0;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointer, true);
      if (hotkey) void call('setMic', [{ hotkey }])();
      else void refresh();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { finishCapture(null); return; }
      const k = keyOfCode(e.code);
      if (k && !held.includes(k)) held.push(k);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (held.length) finishCapture(held.join('+'));
    };
    const onPointer = (e: PointerEvent) => {
      const k = ({ 1: 'Mouse3', 3: 'Mouse4', 4: 'Mouse5' } as Record<number, string>)[e.button];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      finishCapture([...held, k].join('+'));
    };
    keyBtn.addEventListener('click', () => {
      if (capturing) { finishCapture(null); return; }
      capturing = true;
      keyBtn.textContent = '按下新的说话键…(Esc 取消)';
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('pointerdown', onPointer, true);
    });
    ctx.own({ dispose: () => { if (capturing) finishCapture(null); } });
    ctx.stream({
      message: (text: string) => {
        const f = JSON.parse(text) as { type: string; level?: number; speaking?: boolean; open?: boolean };
        if (f.type === 'level' && typeof f.level === 'number') {
          fill.style.width = `${meterPct(f.level)}%`;
          fill.classList.toggle('on', !!f.speaking);
          meter.classList.toggle('open', !!f.open);
        } else void refresh();
      },
    });
    void refresh();
    ctx.interval(() => void refresh(), 1500);
  },
};

const bundle: ConsoleClientBundle = { panels: { pet: petPanel, voice: voicePanel } };
export default bundle;
