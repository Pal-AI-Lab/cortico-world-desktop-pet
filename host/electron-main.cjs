/**
 * Electron main process for the pet window.
 *
 * Run as `electron electron-main.cjs --pet-url=http://127.0.0.1:<port>/pet`, or call
 * `runPetHost({ url, parentPid })` from an app's own main process. With `--parent-pid=<pid>`
 * the window closes once that process exits. The window covers the primary
 * display's work area, is transparent and always on top, and ignores the mouse until the
 * page reports the pointer is over the figure, a bubble or the menu. A tray icon shows,
 * hides and closes it; an embedding app that has its own tray passes `tray: false`.
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, session, shell } = require('electron');
const { join } = require('node:path');

/** 32×32 tray icon drawn in code: the C outline and two ring eyes, white on the brand green. */
function trayIcon() {
  const n = 32, buf = Buffer.alloc(n * n * 4);
  const ring = (px, py, cx, cy, r, w) => Math.abs(Math.hypot(px - cx, py - cy) - r) <= w / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, px = x + .5, py = y + .5;
    const inside = Math.hypot(px - 16, py - 16) <= 15.5;
    const a = Math.atan2(16 - py, px - 16) * 180 / Math.PI;
    const c = ring(px, py, 16, 16, 10.5, 3.6) && Math.abs(a) > 48;
    const eye = ring(px, py, 14.1, 14.6, 2.2, 1.5) || ring(px, py, 20.4, 14.6, 2.2, 1.5);
    const white = c || eye;
    // BGRA
    buf[i] = white ? 255 : 0x70; buf[i + 1] = white ? 255 : 0xA8; buf[i + 2] = white ? 255 : 0x00; buf[i + 3] = inside ? 255 : 0;
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}

function runPetHost({ url, parentPid = 0, tray: withTray = true }) {
  if (!url) throw new Error('pet host needs --pet-url');
  const origin = new URL(url).origin;
  let win = null, tray = null, dress = null;

  const place = () => {
    if (!win) return;
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  };

  const create = () => {
    const wa = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow({
      x: wa.x, y: wa.y, width: wa.width, height: wa.height,
      transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
      backgroundColor: '#00000000', title: 'Cortico 桌宠',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true, sandbox: true, backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith(origin)) { openDress(target); return { action: 'deny' }; }
      shell.openExternal(target);
      return { action: 'deny' };
    });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => { win = null; });
    // page console lines reach the World's log through stdout
    win.webContents.on('console-message', (e) => { if (e.level !== 'debug') console.log(`[page:${e.level}] ${e.message}`); });
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => console.log(`[page:error] 加载失败 ${code} ${desc} ${failedUrl}`));
    win.loadURL(url);
  };

  const openDress = (target = `${origin}/dress`) => {
    if (dress) { dress.show(); dress.focus(); return; }
    dress = new BrowserWindow({ width: 980, height: 720, title: '桌宠装扮', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
    dress.on('closed', () => { dress = null; });
    dress.loadURL(target);
  };

  ipcMain.on('pet:interactive', (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('pet:focus', () => { if (win) win.focus(); });
  ipcMain.on('pet:hide', () => { if (win) win.hide(); });
  ipcMain.on('pet:openDress', () => openDress());

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(permission === 'media' && wc.getURL().startsWith(origin));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => permission === 'media' && requestingOrigin === origin);
    create();
    screen.on('display-metrics-changed', place);
    screen.on('display-added', place);
    screen.on('display-removed', place);
    if (!withTray) return;
    tray = new Tray(trayIcon());
    tray.setToolTip('Cortico 桌宠');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示桌宠', click: () => { if (!win) create(); else win.showInactive(); } },
      { label: '隐藏桌宠', click: () => win && win.hide() },
      { label: '装扮…', click: () => openDress() },
      { type: 'separator' },
      { label: '关闭桌宠窗口', click: () => app.quit() },
    ]));
    tray.on('click', () => { if (win) (win.isVisible() ? win.hide() : win.showInactive()); });
  });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  // with --parent-pid the window closes once that process is gone
  if (parentPid) {
    setInterval(() => {
      try { process.kill(parentPid, 0); } catch { app.quit(); }
    }, 2000).unref();
  }
}

module.exports = { runPetHost };

// Electron's default app loads the script without making it require.main
if (process.argv[1] && require('node:path').resolve(process.argv[1]) === __filename) {
  const arg = process.argv.find((a) => a.startsWith('--pet-url='));
  const parent = process.argv.find((a) => a.startsWith('--parent-pid='));
  runPetHost({ url: arg ? arg.slice('--pet-url='.length) : '', parentPid: parent ? Number(parent.slice('--parent-pid='.length)) : 0 });
}
