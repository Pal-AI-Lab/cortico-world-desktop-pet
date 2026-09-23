/**
 * The pet page. Connects to the World over `/socket?role=pet`, runs the body from pet-core,
 * and turns World orders (say, ask, walk, act, listen) into bubbles and motion. It reports
 * back only what happened on screen: arrivals, answers, touches, typed text, and 16 kHz
 * microphone audio while voice input is on.
 *
 * In the pet window (`window.petHost` from the preload) the page is transparent and the
 * window ignores the mouse except over the figure, a bubble, the menu or the hover buttons.
 * Colors follow the World's `theme` through `data-theme` on the root element.
 */
import { applyTheme, createPet, createSfx, clamp, f, mini, normalizeSkin, skinCss, EXPRESSIONS, HEAD_TOP, ICONS } from './pet-core.js';

const $ = (s) => document.querySelector(s);
const host = window.petHost || null;
document.body.classList.add(host ? 'desk' : 'tab');

const stage = $('#stage');
const bubble = $('#bubble'), heardEl = $('#heard'), trail = $('#trail'), menu = $('#menu');
const tools = $('#tools'), toolChat = $('#toolChat'), toolTheme = $('#toolTheme');
const skinStyle = document.createElement('style');
document.head.appendChild(skinStyle);

const prefs = { roam: 'calm', sound: true, theme: document.documentElement.dataset.theme, scale: 1, user: '主人', mic: false, micDevice: '', bot: null };
const sfx = createSfx();
if (host) sfx.unlock();
else ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => sfx.unlock(), { capture: true }));

const floorGap = () => (host ? 2 : 48);
const ctl = createPet(
  { petG: $('#pet'), shadowEl: $('#shadow'), fxG: $('#fx') },
  {
    sfx,
    roam: prefs.roam,
    bounds: () => ({ W: innerWidth, H: innerHeight, floorY: innerHeight - floorGap(), S: .42 * prefs.scale }),
    onEvent: (kind, d) => onBody(kind, d),
    dialogOpen: () => !!item || !!listen.phase,
    enter: 'drop',
  },
);
addEventListener('resize', () => ctl.resize());

/* ---------- connection ---------- */
let ws = null, backoff = 500, watching = false;
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function connect() {
  ws = new WebSocket(`ws://${location.host}/socket?role=pet&host=${host ? 'window' : 'tab'}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { backoff = 500; send({ t: 'hello', screen: { w: innerWidth, h: innerHeight }, host: host ? 'window' : 'tab' }); };
  ws.onmessage = (e) => { try { onOrder(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = (e) => {
    ws = null;
    stopMic();
    if (e.code === 4000) return; // replaced by a newer pet page
    setTimeout(connect, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
}
connect();

function applyPrefs(p) {
  if (p.skin) { const s = normalizeSkin(p.skin); ctl.setSkin(s); skinStyle.textContent = skinCss(s); }
  if (p.roam) { prefs.roam = p.roam; ctl.setRoam(p.roam); }
  if (typeof p.sound === 'boolean') { prefs.sound = p.sound; sfx.set(p.sound); }
  if (p.theme === 'dark' || p.theme === 'light') { prefs.theme = p.theme; applyTheme(p.theme, toolTheme); }
  if (typeof p.scale === 'number') { prefs.scale = p.scale; ctl.resize(); }
  if (typeof p.user === 'string') prefs.user = p.user;
  if (typeof p.micDevice === 'string' && p.micDevice !== prefs.micDevice) { prefs.micDevice = p.micDevice; stopMic(); }
  if (typeof p.mic === 'boolean') { prefs.mic = p.mic; p.mic && !watching ? startMic() : stopMic(); }
  if (p.bot) { prefs.bot = p.bot; if (!menu.hidden) renderMenuHead(); }
  if (typeof p.thinking === 'boolean') ctl.setThinking(p.thinking);
}

function onOrder(m) {
  switch (m.t) {
    case 'init': case 'prefs': applyPrefs(m); break;
    case 'watching': watching = true; stopMic(); break;
    case 'say': dropAsks(); queue.push({ kind: 'say', id: m.id, beats: m.beats, i: -1 }); ctl.holdRoam(20); break;
    case 'ask': dropAsks(); queue.push({ kind: 'ask', id: m.id, question: m.question, options: m.options || [], own: m.own !== false }); ctl.holdRoam(20); break;
    case 'confirm': dropAsks(); queue.push({ kind: 'ask', confirm: true, id: m.id, question: m.question, options: m.options, own: false }); ctl.holdRoam(20); break;
    case 'walk': walk(m); break;
    case 'act': acts.push(...m.actions); ctl.holdRoam(20); break;
    case 'listen': onListen(m); break;
    case 'thinking': ctl.setThinking(!!m.on); break;
  }
}

/* ---------- body events → World ---------- */
const walkTargets = new Map();
function onBody(kind, d) {
  if (kind === 'arrived' || kind === 'interrupted') {
    if (!d.walkId || !walkTargets.has(d.walkId)) return;
    walkTargets.delete(d.walkId);
    send({ t: kind, walkId: d.walkId, x: d.x / innerWidth, by: d.by });
    if (actWait && actWait.walkId === d.walkId) actWait = null;
  } else if (kind === 'touch') {
    send({ t: 'touch', ...d });
    if (d.kind === 'grab') closeMenu();
  }
}

function walk(m) {
  const x = m.to === 'cursor' ? (pointerSeen ? lastPointer.x : innerWidth / 2) : clamp(Number(m.to), 0, 1) * innerWidth;
  walkTargets.set(m.id, true);
  ctl.holdRoam(20);
  if (!ctl.walkTo(x, !!m.run, m.id)) {
    walkTargets.delete(m.id);
    send({ t: 'interrupted', walkId: m.id, x: ctl.pet.x / innerWidth, by: ctl.pet.mode === 'drag' ? 'drag' : ctl.pet.mode });
  }
}

/* ---------- actions ---------- */
const DUR = { stand: 1.2, jump: 1.2, hop: .9, look: 2.7, turn: .4, nod: .8, shake: .8, spin: .8, sit: .8, sleep: .8, dizzy: 3.2 };
const acts = [];
let actUntil = 0, actWait = null;
function runAction(a) {
  if (EXPRESSIONS.includes(a)) {
    if (a === 'neutral') ctl.setExpr('neutral', .1);
    else ctl.setExpr(a);
    return .9;
  }
  if (a === 'walk' || a === 'run') {
    const id = 'act' + Math.random().toString(36).slice(2);
    const x = ctl.pet.x < innerWidth / 2 ? innerWidth * (.55 + Math.random() * .35) : innerWidth * (.1 + Math.random() * .35);
    if (ctl.walkTo(x, a === 'run', id)) { actWait = { walkId: id }; walkTargets.set(id, true); }
    return 12;
  }
  ctl.act(a);
  return DUR[a] ?? 1;
}
function stepActs() {
  const now = ctl.time;
  if (actWait || now < actUntil || !acts.length) return;
  if (ctl.busy()) return;
  actUntil = now + runAction(acts.shift());
  ctl.holdRoam(15);
}

/* ---------- say / ask ---------- */
const queue = [];
let item = null;
const PAUSE = /[,。!?…、,.!?]/, SILENT = /[\s,。!?…、,.!?「」:()]/;

/** A newer question replaces the bot's open one; a World's confirmation stays until answered. */
function dropAsks() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'ask' && !queue[i].confirm) queue.splice(i, 1);
  if (item && item.kind === 'ask' && !item.answered && !item.confirm) closeBubble();
}

function openBubble(kind, html) {
  bubble.className = 'bubble ' + kind;
  bubble.innerHTML = html;
  bubble.hidden = false;
  void bubble.offsetWidth;
  bubble.classList.add('pop');
}
function closeBubble() {
  bubble.hidden = true; bubble.innerHTML = '';
  item = null;
}

function startItem(it) {
  item = it;
  if (it.kind === 'ask') {
    openBubble('ask', '<button class="b-close" type="button" aria-label="关闭">×</button><p class="b-text"></p><div class="b-opts" hidden></div>');
    bubble.querySelector('.b-close').addEventListener('click', () => dismissAsk());
    it.text = it.question; it.shown = 0; it.acc = 0; it.optsShown = false;
    sfx.pop();
  }
}

function stepDialog(dt) {
  if (!item && queue.length && !ctl.busy()) startItem(queue.shift());
  const it = item;
  if (!it) return;
  if (it.kind === 'say') {
    if (it.i < 0 || it.beatDone) {
      if (it.beatDone && ctl.time < it.holdUntil) return;
      it.i++;
      it.beatDone = false;
      if (it.i >= it.beats.length) { closeBubble(); return; }
      const b = it.beats[it.i];
      let lead = 0;
      for (const a of b.actions || []) { acts.push(a); lead = .45; }
      it.shown = 0; it.acc = 0; it.fired = 0; it.startAt = ctl.time + lead;
      if (b.text) { openBubble('say', '<p class="b-text"></p>'); sfx.pop(); } else { bubble.hidden = true; }
      return;
    }
    const b = it.beats[it.i];
    if (ctl.time < it.startAt) return;
    if (!b.text) { it.beatDone = true; it.holdUntil = ctl.time + .8; return; }
    typeText(it, b.text, dt, b.anchors || []);
    if (it.shown >= b.text.length && !it.beatDone) {
      it.beatDone = true;
      const last = it.i === it.beats.length - 1;
      it.holdUntil = ctl.time + (last ? 1.6 + b.text.length * .07 : .9 + b.text.length * .03);
    }
    return;
  }
  if (it.kind === 'ask') {
    if (it.shown < it.text.length) { typeText(it, it.text, dt, []); return; }
    if (!it.optsShown) { it.optsShown = true; showOptions(it); }
  }
}

function typeText(it, text, dt, anchors) {
  const p = bubble.querySelector('.b-text');
  if (!p || it.shown >= text.length) return;
  it.acc += dt * 20;
  while (it.acc >= 1 && it.shown < text.length) {
    const ch = text[it.shown++];
    it.acc -= PAUSE.test(ch) ? 5 : 1;
    if (!SILENT.test(ch)) { sfx.babble(ch); ctl.talk(); }
    while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) acts.push(...anchors[it.fired++].actions);
  }
  p.textContent = text.slice(0, it.shown);
}

function showOptions(it) {
  const box = bubble.querySelector('.b-opts');
  it.options.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'b-opt';
    b.innerHTML = `<kbd>${i + 1}</kbd><span></span>`;
    b.querySelector('span').textContent = label;
    b.style.animationDelay = (i * .07) + 's';
    b.addEventListener('click', () => answer(b, { index: i }));
    box.appendChild(b);
    setTimeout(() => sfx.blub(), i * 70);
  });
  if (it.own) {
    const form = document.createElement('form');
    form.className = 'b-own';
    form.innerHTML = '<input type="text" maxlength="200" autocomplete="off" placeholder="自己说点什么…" aria-label="自己写回答"><button type="submit">发送</button>';
    form.style.animationDelay = (it.options.length * .07) + 's';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input'), v = input.value.trim();
      if (!v) { input.focus(); return; }
      answer(form, { text: v });
    });
    box.appendChild(form);
  }
  box.hidden = false;
}

function answer(node, a) {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  sfx.select();
  node.classList.add('chosen');
  bubble.querySelectorAll('.b-opt, .b-own').forEach((n) => { if (n !== node) n.classList.add('dim'); });
  send(it.confirm ? { t: 'confirmed', id: it.id, index: a.index } : { t: 'answer', askId: it.id, ...a });
  ctl.setExpr('happy');
  setTimeout(() => { if (item === it) closeBubble(); }, 700);
}
function dismissAsk() {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  send(it.confirm ? { t: 'confirmed', id: it.id, index: null } : { t: 'answer', askId: it.id, dismissed: true });
  closeBubble();
}

/* ---------- typed input: right-click → 说点什么, or double-click ---------- */
function openInput() {
  closeMenu();
  if (item && item.kind === 'ask' && !item.answered) return;
  if (item) closeBubble();
  item = { kind: 'input' };
  openBubble('ask', '<button class="b-close" type="button" aria-label="关闭">×</button><form class="b-own"><input type="text" maxlength="500" autocomplete="off" placeholder="想说什么…" aria-label="打字说话"><button type="submit">发送</button></form>');
  const form = bubble.querySelector('form'), input = form.querySelector('input');
  bubble.querySelector('.b-close').addEventListener('click', () => closeBubble());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    send({ t: 'text', text: v });
    sfx.select(); ctl.setExpr('happy');
    closeBubble();
  });
  host?.focus?.();
  setTimeout(() => input.focus(), 30);
}

/* ---------- listening ---------- */
const listen = { phase: null, text: '', closeAt: 0 };
function onListen(m) {
  if (m.phase === 'start') {
    if (!listen.phase) sfx.listenStart();
    listen.phase = 'hearing'; listen.closeAt = 0;
    ctl.setListening(true);
    showHeard(listen.text, true);
  } else if (m.phase === 'transcribing') {
    listen.phase = listen.phase || 'hearing';
    showHeard(listen.text, true);
  } else if (m.phase === 'partial') {
    listen.text = m.text || '';
    showHeard(listen.text, true);
  } else if (m.phase === 'heard') {
    listen.text = m.text || '';
    listen.phase = 'done';
    showHeard(listen.text, false, '听到了');
    sfx.listenEnd();
    ctl.setListening(false);
    ctl.pet.sqv += .9;
    listen.closeAt = ctl.time + 2.2;
  } else if (m.phase === 'none') {
    if (listen.phase === 'done') return;
    listen.phase = null; listen.text = '';
    heardEl.hidden = true; trail.hidden = true;
    ctl.setListening(false);
  }
}
function showHeard(text, live, hint) {
  heardEl.hidden = false; trail.hidden = false;
  heardEl.innerHTML = `<p class="b-text"><span class="fin"></span>${live ? '<span class="caret" aria-hidden="true"></span>' : ''}</p><span class="b-hint"></span>`;
  heardEl.querySelector('.fin').textContent = text;
  heardEl.querySelector('.b-hint').textContent = hint || (text ? '还在听…' : '正在听…');
}
function stepListen() {
  if (listen.phase === 'done' && ctl.time > listen.closeAt) {
    listen.phase = null; listen.text = '';
    heardEl.hidden = true; trail.hidden = true;
  }
}

/* ---------- microphone ---------- */
let mic = null;
async function startMic() {
  if (mic) return;
  mic = { starting: true };
  try {
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (prefs.micDevice) audio.deviceId = { exact: prefs.micDevice };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('/web/mic-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pet-mic');
    node.port.onmessage = (e) => { if (ws && ws.readyState === 1) ws.send(e.data); };
    src.connect(node);
    if (!prefs.mic || !mic) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); mic = null; return; }
    mic = { stream, ctx, node };
    send({ t: 'mic', state: 'on', detail: stream.getAudioTracks()[0]?.label || null });
    void reportDevices();
  } catch (err) {
    mic = null;
    send({ t: 'mic', state: err && err.name === 'NotAllowedError' ? 'denied' : 'error', detail: String(err && err.message || err) });
  }
}
/** Device labels are readable only after microphone access was granted. */
async function reportDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  send({ t: 'devices', list: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })) });
}
navigator.mediaDevices?.addEventListener('devicechange', () => { if (mic && !mic.starting) void reportDevices(); });
function stopMic() {
  const m = mic;
  mic = null;
  if (!m || m.starting) return;
  m.stream.getTracks().forEach((t) => t.stop());
  m.ctx.close();
  send({ t: 'mic', state: 'off' });
}

/* ---------- menu ---------- */
const ROAM = { free: '常走动', calm: '多待着', off: '不乱动' };
function openMenu(x, y) {
  menu.innerHTML = '';
  if (prefs.bot) {
    menu.appendChild(Object.assign(document.createElement('div'), { className: 'm-head' }));
    renderMenuHead();
    menu.appendChild(document.createElement('hr'));
  }
  const add = (label, val, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.innerHTML = `<span></span><span class="val"></span>`;
    b.firstChild.textContent = label; b.lastChild.textContent = val || '';
    b.addEventListener('click', () => { sfx.tick(); fn(); });
    // pointing at another item folds an open submenu
    b.addEventListener('pointerenter', () => { if (!b.classList.contains('has-sub')) closeSubmenu(); });
    menu.appendChild(b);
    return b;
  };
  /** An item that unfolds its choices beside the menu, the current one checked. */
  const choose = (label, choices, current, pick) => {
    const b = add(label, choices[current], () => openSubmenu(b, choices, current, pick));
    b.classList.add('has-sub');
    b.setAttribute('aria-haspopup', 'menu');
    b.addEventListener('pointerenter', () => openSubmenu(b, choices, current, pick));
  };
  add('说点什么', '', openInput);
  add('麦克风', prefs.mic ? '开' : '关', () => { send({ t: 'prefs', mic: !prefs.mic }); closeMenu(); });
  choose('行为模式', ROAM, prefs.roam, (roam) => send({ t: 'prefs', roam }));
  add('音效', prefs.sound ? '开' : '关', () => { send({ t: 'prefs', sound: !prefs.sound }); closeMenu(); });
  menu.appendChild(document.createElement('hr'));
  add('装扮…', '', () => { closeMenu(); if (host?.openDress) host.openDress(); else window.open('/dress', '_blank'); });
  if (host?.hide) add('隐藏桌宠', '', () => { closeMenu(); host.hide(); });
  if (prefs.bot?.controls && (prefs.bot.buttons?.settings ?? true)) {
    add('打开设置', '', () => { closeMenu(); send({ t: 'control', action: 'settings' }); });
  }
  menu.style.width = '';
  menu.hidden = false;
  // held at its opening width: the quit confirmation in the header must not widen the menu
  menu.style.width = getComputedStyle(menu).width;
  // layout size: the opening animation scales the box, so its bounding rect is still shrunk here
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = f(clamp(x, 8, innerWidth - w - 8)) + 'px';
  menu.style.top = f(clamp(y - h, 8, innerHeight - h - 8)) + 'px';
}
/** Avatar, name and the bot's pause and quit controls, when the World offers them; settings is a row at the bottom. */
function renderMenuHead(confirmQuit = false) {
  const head = menu.querySelector('.m-head'), bot = prefs.bot;
  if (!head || !bot) return;
  head.classList.toggle('confirm', confirmQuit);
  head.innerHTML = '<span class="m-avatar"></span><span class="m-name"></span><span class="m-acts"></span>';
  head.querySelector('.m-avatar').innerHTML = bot.avatar
    ? `<img alt="" src="/api/avatar?v=${encodeURIComponent(bot.avatar)}">`
    : `<svg viewBox="18 18 220 220" aria-hidden="true">${mini('neutral', ctl.skin)}</svg>`;
  const name = head.querySelector('.m-name');
  name.textContent = name.title = confirmQuit ? bot.quitPrompt : bot.name;
  const acts = head.querySelector('.m-acts');
  const act = (iconHtml, label, fn, cls = 'm-act') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = iconHtml;
    b.addEventListener('click', (e) => { e.stopPropagation(); sfx.tick(); fn(); });
    acts.appendChild(b);
  };
  if (!bot.controls) return;
  if (confirmQuit) {
    act(ICONS.power, bot.quitLabel, () => { closeMenu(); send({ t: 'control', action: 'quit' }); }, 'm-act danger');
    act('<span>取消</span>', '取消', () => renderMenuHead(), 'm-act text');
    return;
  }
  // only the controls the embedding app lent; a server without `buttons` lends all three
  const has = bot.buttons ?? { pause: true, settings: true, quit: true };
  if (has.pause) act(bot.paused ? ICONS.play : ICONS.pause, bot.paused ? '继续' : '暂停', () => send({ t: 'control', action: bot.paused ? 'resume' : 'pause' }));
  if (has.quit) act(ICONS.power, bot.quitLabel, () => renderMenuHead(true));
}
function openSubmenu(item, choices, current, pick) {
  if (menu.querySelector('.submenu')?.dataset.for === item.firstChild.textContent) return;
  closeSubmenu();
  const sub = document.createElement('div');
  sub.className = 'submenu';
  sub.dataset.for = item.firstChild.textContent;
  sub.setAttribute('role', 'menu');
  for (const [value, label] of Object.entries(choices)) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(value === current));
    b.innerHTML = '<span></span><span class="val"></span>';
    b.firstChild.textContent = label; b.lastChild.textContent = value === current ? '✓' : '';
    b.addEventListener('click', () => { sfx.tick(); pick(value); closeMenu(); });
    sub.appendChild(b);
  }
  menu.appendChild(sub);
  // beside the menu, on whichever side has room, level with the item
  const r = menu.getBoundingClientRect(), w = sub.offsetWidth, h = sub.offsetHeight;
  const right = r.left + menu.offsetWidth + 4 + w <= innerWidth - 8;
  sub.style.left = f(right ? menu.offsetWidth + 4 : -w - 4) + 'px';
  sub.style.top = f(clamp(item.offsetTop - 6, 8 - r.top, innerHeight - 8 - h - r.top)) + 'px';
}
function closeSubmenu() { menu.querySelector('.submenu')?.remove(); }
function closeMenu() { menu.hidden = true; closeSubmenu(); }

/* ---------- hover buttons: type a line, switch dark/light ---------- */
/** Seconds the buttons stay after the pointer leaves both the pet and them. */
const TOOLS_LINGER = .8;
let toolsUntil = 0;
toolChat.innerHTML = ICONS.chat;
applyTheme(prefs.theme, toolTheme);
toolChat.addEventListener('click', () => { toolsUntil = 0; openInput(); });
toolTheme.addEventListener('click', () => {
  const theme = prefs.theme === 'dark' ? 'light' : 'dark';
  applyPrefs({ theme });
  send({ t: 'prefs', theme });
  sfx.tick();
});
function stepTools() {
  tools.hidden = !(ctl.time < toolsUntil && !ctl.pressing && !ctl.busy() && menu.hidden);
}

/* ---------- pointer ---------- */
let pointerSeen = false;
const lastPointer = { x: 0, y: 0 };
let interactive = null;
function setInteractive(on) {
  if (!host || interactive === on) return;
  interactive = on;
  host.setInteractive(on);
}
const overUi = (e) => e.target.closest && e.target.closest('.bubble:not([hidden]), .menu:not([hidden]), .tools:not([hidden])');
document.addEventListener('pointermove', (e) => {
  pointerSeen = true;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const p = { x: e.clientX, y: e.clientY };
  const cursor = ctl.pointerMove(p);
  stage.style.cursor = cursor;
  const overPet = ctl.hitPet(p);
  if (overPet || (e.target.closest && e.target.closest('.tools'))) toolsUntil = ctl.time + TOOLS_LINGER;
  setInteractive(ctl.pressing || overPet || !!overUi(e));
});
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  closeMenu();
  if (ctl.pointerDown({ x: e.clientX, y: e.clientY })) { stage.setPointerCapture(e.pointerId); e.preventDefault(); }
});
const up = () => { ctl.pointerUp(); stage.style.cursor = ''; };
stage.addEventListener('pointerup', up);
stage.addEventListener('pointercancel', up);
document.addEventListener('pointerleave', () => ctl.pointerLeave());
stage.addEventListener('dblclick', (e) => { if (ctl.hitPet({ x: e.clientX, y: e.clientY })) openInput(); });
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (ctl.hitPet({ x: e.clientX, y: e.clientY })) openMenu(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenu(); }, { capture: true });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    if (item && item.kind === 'ask') dismissAsk();
    else if (item && item.kind === 'input') closeBubble();
    return;
  }
  const typing = e.target.closest && e.target.closest('input');
  if (item && item.kind === 'ask' && item.optsShown && !item.answered && !typing && /^[123]$/.test(e.key)) {
    const b = bubble.querySelectorAll('.b-opt')[+e.key - 1];
    if (b) b.click();
  }
});

/* ---------- layout ---------- */
function place(el, a, extraUp, side) {
  const bw = el.offsetWidth, bh = el.offsetHeight;
  const cx = a.x + side * (bw / 2 + 10);
  const left = clamp(cx - bw / 2 + (side ? 0 : ctl.pet.facing * 26), 10, Math.max(10, innerWidth - bw - 10));
  const top = Math.max(8, a.y - bh - extraUp);
  el.style.left = f(left) + 'px';
  el.style.top = f(top) + 'px';
  el.style.setProperty('--tail', f(clamp(a.x - left, 22, bw - 22)) + 'px');
  return { left, top, bw, bh };
}
/** Beside the body, on the right unless that runs off the screen. */
function placeTools() {
  const c = ctl.toStage(128, 128 + ctl.pet.low), reach = 104 * ctl.bounds.S + 10;
  const w = tools.offsetWidth, h = tools.offsetHeight;
  const left = c.x + reach + w <= innerWidth - 8 ? c.x + reach : c.x - reach - w;
  tools.style.left = f(clamp(left, 8, innerWidth - w - 8)) + 'px';
  tools.style.top = f(clamp(c.y - h / 2, 8, innerHeight - h - 8)) + 'px';
}
function layout() {
  if (!tools.hidden) placeTools();
  const a = ctl.anchor();
  let sayBox = null;
  if (!bubble.hidden) sayBox = place(bubble, a, 18, 0);
  if (!heardEl.hidden) {
    const side = sayBox ? -ctl.pet.facing : 0;
    const r = place(heardEl, a, 46, side);
    const bx = r.left + r.bw / 2, by = r.top + r.bh;
    [...trail.children].forEach((d, i) => {
      const k = [.22, .5, .78][i], sz = [7, 10, 13][i];
      d.style.width = d.style.height = sz + 'px';
      d.style.left = f(a.x + (bx - a.x) * k - sz / 2) + 'px';
      d.style.top = f(a.y - 4 + (by + 4 - a.y + 4) * k - sz / 2) + 'px';
    });
  }
}

/* ---------- backdrop: a light gray halo when the body melts into what is behind it ---------- */
/** Seconds between looks at the screen around the body. */
const BACKDROP_EVERY = .8;
/** OKLab distance under which a backdrop pixel counts as the body's color. */
const SAME_COLOR = .15;
/** Share of such pixels around the body that turns the halo on (most of them), and the share it turns off below. */
const HALO_ON = .6, HALO_OFF = .45;
/** The halo's opacity when fully on. */
const HALO_STRENGTH = .8;
const petG = $('#pet'), haloFlood = $('#haloFlood');
// a window host too old to sample the screen keeps the halo on; a browser tab draws its own wall
const backdrop = { on: !!host && !host.sampleBackdrop, fixed: !!host && !host.sampleBackdrop, k: 0, busy: false, next: 0 };

const lin = (c) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
function oklab(r, g, b) {
  r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
/** The body's color as [r, g, b], from `--skin-ink` (#rgb or #rrggbb). */
function inkRgb() {
  let h = getComputedStyle(document.documentElement).getPropertyValue('--skin-ink').trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return /^[0-9a-f]{6}$/i.test(h) ? [n >> 16, (n >> 8) & 255, n & 255] : null;
}
/** The figure's box in page pixels, from its geometry: the halo filter would widen its client rect. */
function bodyRect() {
  const top = Math.min(20, HEAD_TOP[ctl.skin.head] ?? 12);
  const pts = [[20, top], [236, top], [20, 256], [236, 256]].map(([x, y]) => ctl.toStage(x, y));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };

/** Samples a ring around the body (past the halo's reach, minus the page's own bubbles) and flips the halo. */
async function probeBackdrop() {
  const ink = inkRgb();
  if (!ink) return;
  const body = bodyRect(), S = ctl.bounds.S;
  const near = inflate(body, 4 + 34 * S), far = inflate(near, 8 + 40 * S);
  const x = Math.max(0, far.x), y = Math.max(0, far.y);
  const rect = { x, y, width: Math.min(innerWidth, far.x + far.width) - x, height: Math.min(innerHeight, far.y + far.height) - y };
  const skip = [near, ...[bubble, heardEl, menu, tools].filter((el) => !el.hidden).map(rectOf)];
  const px = await host.sampleBackdrop(rect, skip);
  // this platform cannot read the screen cheaply: the halo just stays
  if (px === null) { backdrop.on = true; backdrop.fixed = true; return; }
  const n = px.length / 3;
  if (n < 24) return;
  const [L, A, B] = oklab(...ink);
  let same = 0;
  for (let i = 0; i < px.length; i += 3) {
    const [l, a, b] = oklab(px[i], px[i + 1], px[i + 2]);
    if (Math.hypot(l - L, a - A, b - B) < SAME_COLOR) same++;
  }
  const share = same / n;
  backdrop.on = backdrop.on ? share >= HALO_OFF : share > HALO_ON;
}
function stepBackdrop(dt) {
  const now = performance.now() / 1000;
  if (host?.sampleBackdrop && !backdrop.fixed && !backdrop.busy && now >= backdrop.next && document.visibilityState === 'visible') {
    backdrop.busy = true;
    probeBackdrop().catch(() => {}).finally(() => { backdrop.busy = false; backdrop.next = performance.now() / 1000 + BACKDROP_EVERY; });
  }
  const k = backdrop.k + ((backdrop.on ? 1 : 0) - backdrop.k) * Math.min(1, dt * 6);
  backdrop.k = k < .005 ? 0 : k;
  if (backdrop.k) { haloFlood.setAttribute('flood-opacity', (backdrop.k * HALO_STRENGTH).toFixed(2)); petG.setAttribute('filter', 'url(#halo)'); }
  else petG.removeAttribute('filter');
}

/* ---------- loop ---------- */
let last = performance.now();
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  stepActs();
  stepDialog(dt);
  stepListen();
  ctl.step(dt);
  ctl.render();
  stepBackdrop(dt);
  stepTools();
  layout();
  requestAnimationFrame(frame);
}
ctl.render();
requestAnimationFrame(frame);
