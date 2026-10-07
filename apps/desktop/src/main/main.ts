import { app, BaseWindow, WebContentsView, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BaseWindow | null = null;
let appView: WebContentsView | null = null;
let browserView: WebContentsView | null = null;
let tray: Tray | null = null;

const COMPACT_WIDTH = 680;
const COMPACT_HEIGHT = 160;
const EXPANDED_WIDTH = 900;
const EXPANDED_HEIGHT = 700;

// Window and tray icons (rendered from packaging/icon.svg). Same relative path in dev and in app.asar.
const RESOURCES = path.join(__dirname, '../../resources');

// Unpackaged runs (pnpm dev / start) keep their own profile, so a dev build never migrates the
// installed app's surge.db or fights it for the single-instance lock. --user-data-dir still wins.
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Surge Dev'));
}

// One instance per user profile: a second launch (Start menu, the installer's "Run Surge") focuses
// the running window instead of opening another app on the same surge.db, tray and shortcut.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createMainWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  mainWindow = new BaseWindow({
    title: 'Surge',
    icon: path.join(RESOURCES, 'icon.png'),
    width: COMPACT_WIDTH,
    height: COMPACT_HEIGHT,
    x: Math.round((screenW - COMPACT_WIDTH) / 2),
    y: Math.round(screenH * 0.3),
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    show: false,
    alwaysOnTop: false,
  });

  // App UI View (React renderer)
  appView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.contentView.addChildView(appView);
  appView.setBounds({ x: 0, y: 0, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });

  // Browser View (for MCPWeb sites - initially hidden)
  browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Surface embedded-browser navigation to the renderer (drives URL bar + history).
  const emitNavigate = (url: string) => appView?.webContents.send('browser:didNavigate', url);
  browserView.webContents.on('did-navigate', (_e: any, url: string) => emitNavigate(url));
  browserView.webContents.on('did-navigate-in-page', (_e: any, url: string) => emitNavigate(url));

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    appView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    appView.webContents.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('ready-to-show' as any, () => {
    mainWindow?.show();
  });

  // Wait for appView to be ready
  appView.webContents.on('did-finish-load', () => {
    mainWindow?.show();
  });

  // Re-layout views when window is resized (drag edges, maximize, etc.)
  mainWindow.on('resize' as any, layoutViews);

  mainWindow.on('closed' as any, () => {
    mainWindow = null;
    appView = null;
    browserView = null;
  });
}

/**
 * The one place that sizes the two views. With the web page attached, the app UI gets a 400px
 * column on the left (half the window if that's narrower) and the page the rest; otherwise the
 * app UI fills the window. Every path that changes the window or attaches/detaches the page calls
 * this, so the app UI is never laid out full-width underneath the page.
 */
function layoutViews(): void {
  if (!mainWindow || !appView) return;
  const { width, height } = mainWindow.getBounds();
  if (browserView && mainWindow.contentView.children.includes(browserView)) {
    const column = Math.min(400, Math.round(width / 2));
    appView.setBounds({ x: 0, y: 0, width: column, height });
    browserView.setBounds({ x: column, y: 0, width: width - column, height });
  } else {
    appView.setBounds({ x: 0, y: 0, width, height });
  }
}

function setupTray(): void {
  tray = new Tray(nativeImage.createFromPath(path.join(RESOURCES, 'tray.png')));
  tray.setToolTip('Surge — MCP Browser');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Surge', click: () => mainWindow?.show() },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
}

// Window resize handler
ipcMain.on('window:resize', (_event, mode: 'compact' | 'expanded') => {
  if (!mainWindow || !appView) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  if (mode === 'expanded') {
    const newX = Math.round((screenW - EXPANDED_WIDTH) / 2);
    const newY = Math.round((screenH - EXPANDED_HEIGHT) / 2);
    mainWindow.setBounds({ x: newX, y: newY, width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT });
  } else {
    const newX = Math.round((screenW - COMPACT_WIDTH) / 2);
    const newY = Math.round(screenH * 0.3);
    mainWindow.setBounds({ x: newX, y: newY, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
  }
  // Keep the page split if it's showing: stretching the app UI to the full window here used to
  // leave it underneath the page (e.g. Settings, opened while a site was open, was half covered).
  layoutViews();
});

// Browser view controls
ipcMain.on('browser:navigate', (_event, url: string) => {
  if (browserView) {
    browserView.webContents.loadURL(url);
  }
});

ipcMain.on('browser:show', () => {
  if (!mainWindow || !browserView) return;
  mainWindow.contentView.addChildView(browserView);
  layoutViews();
});

ipcMain.on('browser:hide', () => {
  if (!mainWindow || !browserView) return;
  mainWindow.contentView.removeChildView(browserView);
  layoutViews();
});

ipcMain.on('browser:back', () => {
  const wc: any = browserView?.webContents;
  if (!wc) return;
  if (wc.navigationHistory?.canGoBack?.()) wc.navigationHistory.goBack();
  else if (wc.canGoBack?.()) wc.goBack();
});

ipcMain.on('browser:forward', () => {
  const wc: any = browserView?.webContents;
  if (!wc) return;
  if (wc.navigationHistory?.canGoForward?.()) wc.navigationHistory.goForward();
  else if (wc.canGoForward?.()) wc.goForward();
});

// Window drag support
ipcMain.on('window:startDrag', () => {
  // Handled by CSS -webkit-app-region: drag
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (!mainWindow || !appView) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  layoutViews();
  // Notify renderer of maximize state
  appView.webContents.send('window:maximizeChanged', mainWindow.isMaximized());
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;

  // Set up application menu with Edit accelerators (Copy/Paste/Cut/SelectAll)
  // Required for frameless windows where default menu is removed
  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', accelerator: 'CmdOrCtrl+Z' },
        { role: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
        { type: 'separator' },
        { role: 'cut', accelerator: 'CmdOrCtrl+X' },
        { role: 'copy', accelerator: 'CmdOrCtrl+C' },
        { role: 'paste', accelerator: 'CmdOrCtrl+V' },
        { role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  createMainWindow();
  setupTray();
  registerIpcHandlers(() => browserView);

  // Global shortcut to summon Surge
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }
});
