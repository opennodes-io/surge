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

function createMainWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  mainWindow = new BaseWindow({
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
  mainWindow.on('resize' as any, () => {
    if (!mainWindow || !appView) return;
    const bounds = mainWindow.getBounds();
    if (browserView && mainWindow.contentView.children.includes(browserView)) {
      const splitPoint = Math.min(400, Math.round(bounds.width * 0.4));
      appView.setBounds({ x: 0, y: 0, width: splitPoint, height: bounds.height });
      browserView.setBounds({ x: splitPoint, y: 0, width: bounds.width - splitPoint, height: bounds.height });
    } else {
      appView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    }
  });

  mainWindow.on('closed' as any, () => {
    mainWindow = null;
    appView = null;
    browserView = null;
  });
}

function setupTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
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
    appView.setBounds({ x: 0, y: 0, width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT });
  } else {
    const newX = Math.round((screenW - COMPACT_WIDTH) / 2);
    const newY = Math.round(screenH * 0.3);
    mainWindow.setBounds({ x: newX, y: newY, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
    appView.setBounds({ x: 0, y: 0, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
  }
});

// Browser view controls
ipcMain.on('browser:navigate', (_event, url: string) => {
  if (browserView) {
    browserView.webContents.loadURL(url);
  }
});

ipcMain.on('browser:show', () => {
  if (!mainWindow || !browserView || !appView) return;
  const bounds = mainWindow.getBounds();
  const splitPoint = 400;
  appView.setBounds({ x: 0, y: 0, width: splitPoint, height: bounds.height });
  browserView.setBounds({ x: splitPoint, y: 0, width: bounds.width - splitPoint, height: bounds.height });
  mainWindow.contentView.addChildView(browserView);
});

ipcMain.on('browser:hide', () => {
  if (!mainWindow || !browserView || !appView) return;
  mainWindow.contentView.removeChildView(browserView);
  const bounds = mainWindow.getBounds();
  appView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
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
  // Re-layout views to fill the new window size
  const bounds = mainWindow.getBounds();
  if (browserView && mainWindow.contentView.children.includes(browserView)) {
    const splitPoint = 400;
    appView.setBounds({ x: 0, y: 0, width: splitPoint, height: bounds.height });
    browserView.setBounds({ x: splitPoint, y: 0, width: bounds.width - splitPoint, height: bounds.height });
  } else {
    appView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  }
  // Notify renderer of maximize state
  appView.webContents.send('window:maximizeChanged', mainWindow.isMaximized());
});

app.whenReady().then(() => {
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
