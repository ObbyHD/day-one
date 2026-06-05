const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Autoplay ohne User-Geste erlauben (YouTube, Audio)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Web Speech API aktivieren
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeech');

const PORT = 8771;
let mainWindow = null;
let tray = null;

// ── userData .env ────────────────────────────────────────────────────────────
// API-Key und Einstellungen liegen in %APPDATA%/Day One/.env
// Beim ersten Start wird .env.example als Vorlage kopiert.
function ensureUserEnv() {
  const userDataPath = app.getPath('userData');
  const dest = path.join(userDataPath, '.env');
  if (!fs.existsSync(dest)) {
    const exampleSrc = app.isPackaged
      ? path.join(process.resourcesPath, 'app', '.env.example')
      : path.join(__dirname, '.env.example');
    try {
      if (fs.existsSync(exampleSrc)) fs.copyFileSync(exampleSrc, dest);
      else fs.writeFileSync(dest, '# Day One Konfiguration\nOPENAI_API_KEY=\n', 'utf8');
    } catch {}
  }
  return dest;
}

// ── Alten Prozess auf Port killen (damit immer die aktuelle Version läuft) ──
function freePort(port) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
      if (!stdout || !stdout.trim()) return resolve();
      const match = stdout.match(/\s+(\d+)\s*$/m);
      if (!match) return resolve();
      const pid = match[1].trim();
      exec(`taskkill /F /PID ${pid}`, () => setTimeout(resolve, 400));
    });
  });
}

// ── Server (läuft im selben Prozess) ────────────────────────────────────────
function startServer(envPath) {
  // Env-Pfad setzen, bevor server/index.js geladen wird
  process.env.DAYONE_ENV_PATH = envPath;

  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'server', 'index.js')
    : path.join(__dirname, 'server', 'index.js');

  try {
    require(serverPath);
  } catch (e) {
    console.error('Server-Fehler:', e);
  }
}

// ── Warte bis Server antwortet ───────────────────────────────────────────────
function waitForServer(cb, attempts = 0) {
  http.get(`http://localhost:${PORT}/api/health`, (res) => {
    if (res.statusCode === 200) cb();
    else retry();
  }).on('error', retry);

  function retry() {
    if (attempts < 40) setTimeout(() => waitForServer(cb, attempts + 1), 250);
    else { console.error('Server antwortet nicht.'); cb(); }
  }
}

// ── Hauptfenster ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    title: 'Day One',
  });

  mainWindow.setMenuBarVisibility(false);

  // Mikrofon + Speech immer erlauben (für Diktierfunktion)
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'notifications', 'speech'];
    callback(allowed.includes(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return ['microphone', 'media', 'audioCapture', 'speech'].includes(permission);
  });

  waitForServer(() => {
    mainWindow?.loadURL(`http://localhost:${PORT}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Schließen → Tray (nicht beenden)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── System-Tray ───────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Day One');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Day One öffnen',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: 'API-Key einstellen',
      click: () => {
        const envPath = path.join(app.getPath('userData'), '.env');
        shell.openPath(envPath);
      },
    },
    { type: 'separator' },
    {
      label: 'Beenden',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── App-Start ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Autostart mit Windows
  app.setLoginItemSettings({
    openAtLogin: true,
    name: 'Day One',
    args: ['--hidden'],
  });

  // Alten Node-Prozess auf Port killen → immer aktuelle Server-Version
  await freePort(PORT);

  const envPath = ensureUserEnv();
  startServer(envPath);
  createWindow();
  createTray();

  // --hidden Flag: beim Autostart kein Fenster öffnen, nur Tray
  if (process.argv.includes('--hidden')) {
    mainWindow?.hide();
  }
});

app.on('window-all-closed', () => {
  // Nicht beenden — läuft im Tray weiter
});

app.on('activate', () => {
  mainWindow?.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
