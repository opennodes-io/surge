// Renders packaging/icon.svg to the PNGs the app and the installer use, with Electron's own Chromium,
// so there's no image dependency. Run from apps/desktop after editing the SVG:
//   electron packaging/render-icons.cjs
// packaging/icon.png (512) is electron-builder's source for the .exe and installer icons;
// resources/ holds the runtime window and tray icons (tray@2x is picked up on HiDPI).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const outputs = [
  ['packaging/icon.png', 512],
  ['resources/icon.png', 256],
  ['resources/tray.png', 16],
  ['resources/tray@2x.png', 32],
];

app.whenReady().then(async () => {
  // A hidden window never paints, so render offscreen and take the first painted frame.
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg style="display:block;width:100vw;height:100vh" ')}</body></html>`;
  const painted = new Promise((resolve) => win.webContents.on('paint', (_e, _dirty, image) => { if (!image.isEmpty()) resolve(image); }));
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  const full = await painted;
  for (const [file, size] of outputs) {
    const img = size === 512 ? full : full.resize({ width: size, height: size, quality: 'best' });
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), img.toPNG());
    console.log(`${file}  ${size}x${size}`);
  }
  app.exit(0);
});
