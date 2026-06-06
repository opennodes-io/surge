import type { WebContentsView } from 'electron';
import type { BrowserPort } from '@surge/core';

/** Electron implementation of the core BrowserPort over the embedded WebContentsView. */
export class ElectronBrowserPort implements BrowserPort {
  constructor(private getView: () => WebContentsView | null) {}

  private wc() {
    const view = this.getView();
    if (!view) throw new Error('No browser view available');
    return view.webContents;
  }

  evaluate(js: string): Promise<any> {
    return this.wc().executeJavaScript(js, true);
  }

  async navigate(url: string): Promise<void> {
    await this.wc().loadURL(url);
  }

  loadURL(url: string): Promise<void> {
    return this.navigate(url);
  }

  getUrl(): string | null {
    try {
      return this.getView()?.webContents.getURL() || null;
    } catch {
      return null;
    }
  }

  getTitle(): string | null {
    try {
      return this.getView()?.webContents.getTitle() || null;
    } catch {
      return null;
    }
  }
}
