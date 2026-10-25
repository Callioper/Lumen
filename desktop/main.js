// The desktop app: Electron runs Lumen's own server (server/main.ts) as a child process on Electron's
// Node, and shows it in a window. Nothing else changes: the same server, the same pages, the same API,
// so a browser (or a phone client) can still reach it while the app is open.
//
// Data lives in the user's app-data folder (Windows %APPDATA%\Lumen\data, macOS ~/Library/Application
// Support/Lumen/data, Linux ~/.config/Lumen/data), so an upgrade replaces the program and keeps it.
import { app, BrowserWindow, dialog, Menu, Notification, nativeTheme, shell } from 'electron';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// A separate profile for trying the app out without touching the real one.
if (process.env.LUMEN_DESKTOP_HOME) app.setPath('userData', process.env.LUMEN_DESKTOP_HOME);
const SERVER = join(ROOT, 'server', 'main.ts');
const DATA = join(app.getPath('userData'), 'data');
const WINDOW_FILE = join(app.getPath('userData'), 'window.json');
const DEFAULT_PORT = 8780;
const STOP_WAIT_MS = 5000;
const STDERR_KEEP = 4000;          // characters of the server's stderr kept for the error dialog
const HOME = 'https://github.com/Callioper/Lumen';
const SITE = 'https://callioper.github.io/Lumen/';

let win = null;
let server = null;                 // the child we started; null when we found a Lumen already running
let base = null;                   // http://127.0.0.1:<port>
let quitting = false;

// A second launch just brings the first window forward (second-instance below).
// Windows shows a notification only for an app it knows by this id: the installer's (electron-builder.yml appId).
if (process.platform === 'win32') app.setAppUserModelId('io.github.callioper.lumen');
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const portSetting = () => {
  try { return JSON.parse(readFileSync(join(DATA, 'settings.json'), 'utf8')).port ?? DEFAULT_PORT; } catch { return DEFAULT_PORT; }
};

// Another Lumen (an older copy, or one started from the command line) may hold the port already.
async function lumenAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    return r.ok && 'feeds' in (await r.json());
  } catch { return false; }
}

function startServer() {
  mkdirSync(DATA, { recursive: true });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = fork(SERVER, [], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LUMEN_DATA: DATA },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
    child.on('message', (m) => { if (m && typeof m.ready === 'number') { server = child; resolve(m.ready); } });
    child.on('exit', (code) => {
      if (server !== child) { reject(new Error(stderr.trim() || `服务进程退出（code ${code}）`)); return; }
      server = null;
      if (!quitting) {
        dialog.showErrorBox('Lumen 停止了', `后台服务意外退出（code ${code}）。日志在：\n${join(DATA, 'lumen.log')}`);
        app.quit();
      }
    });
  });
}

function stopServer() {
  if (!server) return Promise.resolve();
  const child = server;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, STOP_WAIT_MS);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send('shutdown'); else child.kill();
  });
}

function savedBounds() {
  try { return JSON.parse(readFileSync(WINDOW_FILE, 'utf8')); } catch { return { width: 1360, height: 880 }; }
}

const LOADING = (dark) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8">
<body style="margin:0;height:100vh;display:grid;place-items:center;background:${dark ? '#100F0F' : '#FFFCF0'};color:${dark ? '#878580' : '#6F6E69'};font:14px system-ui,'Microsoft YaHei',sans-serif">正在启动 Lumen……</body>`)}`;

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    ...savedBounds(), minWidth: 380, minHeight: 500, title: 'Lumen', show: false,
    backgroundColor: dark ? '#100F0F' : '#FFFCF0', autoHideMenuBar: true,
    icon: process.platform === 'linux' ? join(ROOT, 'desktop', 'build', 'icon.png') : undefined,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // Saved when the user finishes moving or resizing: a window closed from the page skips 'close'.
  const keepBounds = () => { try { writeFileSync(WINDOW_FILE, JSON.stringify(win.getBounds())); } catch {} };
  win.on('resized', keepBounds);
  win.on('moved', keepBounds);
  win.on('closed', () => { win = null; });

  // Links out of Lumen (articles, 知网, 豆瓣) open in the default browser, not in the app window.
  const external = (url) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (base && url.startsWith(base)) return { action: 'allow' };
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (base && url.startsWith(base)) return;
    if (url.startsWith('data:')) return;
    e.preventDefault();
    external(url);
  });

  void win.loadURL(base ? `${base}/` : LOADING(dark));
}

// 帮助 → 检查更新: the server asks GitHub once (server/api/update.ts); a newer version is downloaded
// from its release page and installed over this one, the data folder left as it is.
async function checkForUpdate() {
  try {
    if (!base) throw new Error('Lumen 还没启动好');
    const r = await (await fetch(`${base}/api/update`, { signal: AbortSignal.timeout(15_000) })).json();
    if (r.error) throw new Error(r.error);
    if (!r.newer) { void dialog.showMessageBox({ type: 'info', message: `已经是最新版本（v${r.current}）。` }); return; }
    const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['去下载', '看更新了什么', '以后再说'], defaultId: 0, cancelId: 2,
      message: `有新版本 v${r.latest}`, detail: `现在是 v${r.current}。下载新的安装包覆盖安装即可，订阅和文章都在数据文件夹里，不受影响。` });
    if (response === 0) void shell.openExternal(r.url);
    if (response === 1) void shell.openExternal(`${SITE}releases.html`);
  } catch (e) {
    void dialog.showMessageBox({ type: 'warning', message: '没能检查更新', detail: e.message });
  }
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', click: () => base && void shell.openExternal(`${base}/`) },
        { label: '打开数据文件夹', click: () => void shell.openPath(DATA) },
        { label: '打开日志', click: () => void shell.openPath(join(DATA, 'lumen.log')) },
        { type: 'separator' },
        mac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
      { role: 'toggleDevTools', label: '开发者工具' }] },
    { label: '帮助', submenu: [
      { label: '检查更新…', click: () => void checkForUpdate() },
      { label: '更新日志', click: () => void shell.openExternal(`${SITE}releases.html`) },
      { type: 'separator' },
      { label: '主页', click: () => void shell.openExternal(SITE) },
      { label: '在线演示', click: () => void shell.openExternal(`${SITE}demo/`) },
      { label: '安装与配置说明', click: () => void shell.openExternal(`${HOME}#快速安装`) },
      { label: '源码', click: () => void shell.openExternal(HOME) },
      { label: '报告问题', click: () => void shell.openExternal(`${HOME}/issues`) },
      { type: 'separator' },
      { label: `Lumen v${app.getVersion()}`, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A newer version the server's daily check found (server/api/update.ts): told once per version by a
// system notification, which opens the release notes; 首页 shows it too, until it is installed.
const NOTIFIED_FILE = join(app.getPath('userData'), 'update-notified.txt');
const UPDATE_FIRST_MS = 2 * 60_000;          // after the server's first check (a minute in)
const UPDATE_EVERY_MS = 6 * 60 * 60_000;

async function tellOfUpdate() {
  try {
    if (!base || !Notification.isSupported()) return;
    const { update } = await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(10_000) })).json();
    if (!update?.newer || !update.latest) return;
    if (existsSync(NOTIFIED_FILE) && readFileSync(NOTIFIED_FILE, 'utf8').trim() === update.latest) return;
    writeFileSync(NOTIFIED_FILE, update.latest);
    const n = new Notification({ title: `Lumen 有新版本 v${update.latest}`, body: `现在是 v${update.current}。点这里看更新了什么；下载新的安装包覆盖安装即可。` });
    n.on('click', () => void shell.openExternal(`${SITE}releases.html`));
    n.show();
  } catch {
    // Not now: looked at again in a few hours.
  }
}

async function boot() {
  buildMenu();
  createWindow();
  try {
    base = `http://127.0.0.1:${await startServer()}`;
  } catch (err) {
    const port = portSetting();
    if (await lumenAt(port)) {
      base = `http://127.0.0.1:${port}`;        // use the Lumen that is already running; it is not ours to stop
    } else {
      dialog.showErrorBox('Lumen 没能启动', `${err.message}\n\n数据文件夹：${DATA}`);
      app.quit();
      return;
    }
  }
  if (win) void win.loadURL(`${base}/`);
  setTimeout(() => void tellOfUpdate(), UPDATE_FIRST_MS);
  setInterval(() => void tellOfUpdate(), UPDATE_EVERY_MS);
}

app.on('second-instance', () => {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.focus();
});

// On macOS the app (and the server, still fetching) stays in the Dock when the window closes.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win && base) createWindow(); });

app.on('before-quit', (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  void stopServer().then(() => app.quit());
});

if (!primary) {
  // nothing: quitting
} else if (!existsSync(SERVER)) {
  app.whenReady().then(() => { dialog.showErrorBox('Lumen 没能启动', `找不到 ${SERVER}`); app.quit(); });
} else {
  app.whenReady().then(boot);
}
