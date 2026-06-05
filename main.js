const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Auto-Updater (electron-updater) — nur im gepackten Build aktiv
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

// Autoplay ohne User-Geste erlauben (YouTube, Audio)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Web Speech API aktivieren
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeech');

// App-Name explizit setzen → userData ist immer %APPDATA%\Day One (auch im Dev)
app.setName('Day One');

const PORT = 8771;
let mainWindow = null;
let updaterWindow = null;
let tray = null;

// ── userData .env ────────────────────────────────────────────────────────────
// API-Key liegt in %APPDATA%/Day One/.env. Wir kopieren NIE den Platzhalter-Key
// aus .env.example (sonst überschreibt er einen echten Key) — nur ein leeres Template.
function ensureUserEnv() {
  const userDataPath = app.getPath('userData');
  const dest = path.join(userDataPath, '.env');
  const TEMPLATE = '# Day One Konfiguration — trag hier deinen OpenAI-Key ein:\nOPENAI_API_KEY=\n# OPENAI_MODEL=gpt-4o\n';
  try {
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, TEMPLATE, 'utf8');
    } else {
      // Falls eine alte Datei den Platzhalter-Key enthält: bereinigen
      const txt = fs.readFileSync(dest, 'utf8');
      if (txt.includes('dein-key-hier') || /OPENAI_API_KEY=sk-\.\.\./.test(txt)) {
        fs.writeFileSync(dest, TEMPLATE, 'utf8');
      }
    }
  } catch {}
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

  // __dirname funktioniert in Dev UND im gepackten asar (Electron liest asar
  // transparent). process.resourcesPath/app gibt es bei asar:true NICHT.
  const serverPath = path.join(__dirname, 'server', 'index.js');

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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
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

  // Falls der Renderer abstürzt: automatisch neu laden
  mainWindow.webContents.on('render-process-gone', () => {
    if (!app.isQuitting && mainWindow) {
      setTimeout(() => { try { mainWindow.reload(); } catch {} }, 400);
    }
  });
  // DevTools nur wenn DAYONE_DEVTOOLS gesetzt (zum Debuggen)
  if (!app.isPackaged && process.env.DAYONE_DEVTOOLS) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

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

// ── Updater-Fenster (Aktualisieren · Reparieren · Installieren) ───────────────
function sendUpdaterStatus(data) {
  try { updaterWindow?.webContents.send('updater:status', data); } catch {}
}

function createUpdaterWindow() {
  if (updaterWindow) { updaterWindow.show(); updaterWindow.focus(); return; }
  updaterWindow = new BrowserWindow({
    width: 600, height: 420, resizable: false, frame: false,
    backgroundColor: '#111111', title: 'Day One – Installer',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });
  updaterWindow.loadFile(path.join(__dirname, 'updater.html'));
  updaterWindow.once('ready-to-show', () => updaterWindow.show());
  updaterWindow.on('closed', () => { updaterWindow = null; });
}

// electron-updater Events an das Fenster weiterleiten
function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdaterStatus({ type: 'checking' }));
  autoUpdater.on('update-available', (i) => sendUpdaterStatus({ type: 'available', version: i?.version }));
  autoUpdater.on('update-not-available', () => sendUpdaterStatus({ type: 'none' }));
  autoUpdater.on('download-progress', (p) => sendUpdaterStatus({ type: 'progress', percent: p?.percent || 0 }));
  autoUpdater.on('update-downloaded', () => sendUpdaterStatus({ type: 'downloaded' }));
  autoUpdater.on('error', (e) => sendUpdaterStatus({ type: 'error', message: String(e?.message || e) }));
}

// IPC-Handler für die 3 Buttons
function setupUpdaterIPC() {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('updater:check', async () => {
    if (!autoUpdater) { sendUpdaterStatus({ type: 'error', message: 'Updater nur im installierten Build verfügbar.' }); return; }
    try { await autoUpdater.checkForUpdates(); } catch (e) { sendUpdaterStatus({ type: 'error', message: String(e?.message || e) }); }
  });

  // Installieren: heruntergeladenes Update übernehmen & neu starten
  ipcMain.handle('updater:install', async () => {
    if (!autoUpdater) { sendUpdaterStatus({ type: 'error', message: 'Updater nur im installierten Build verfügbar.' }); return; }
    try {
      sendUpdaterStatus({ type: 'installing' });
      app.isQuitting = true;
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    } catch (e) { sendUpdaterStatus({ type: 'error', message: String(e?.message || e) }); }
  });

  // Reparieren: aktuelle Version neu herunterladen & installieren
  ipcMain.handle('updater:repair', async () => {
    if (!autoUpdater) { sendUpdaterStatus({ type: 'error', message: 'Updater nur im installierten Build verfügbar.' }); return; }
    try {
      sendUpdaterStatus({ type: 'checking' });
      autoUpdater.allowDowngrade = true;        // gleiche/ältere Version erneut zulassen
      autoUpdater.autoDownload = true;
      await autoUpdater.checkForUpdates();        // lädt latest, ersetzt Dateien
    } catch (e) { sendUpdaterStatus({ type: 'error', message: String(e?.message || e) }); }
  });
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
    {
      label: 'Updates / Installer …',
      click: () => createUpdaterWindow(),
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
  setupAutoUpdater();
  setupUpdaterIPC();

  // --hidden Flag: beim Autostart kein Fenster öffnen, nur Tray
  if (process.argv.includes('--hidden')) {
    mainWindow?.hide();
  }

  // Im Hintergrund still nach Updates schauen (nur gepackter Build)
  if (autoUpdater && app.isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
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
