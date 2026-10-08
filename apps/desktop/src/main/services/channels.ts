import { ipcMain, session } from 'electron';

/**
 * Social channels: TikTok, Instagram and the like, read in Surge's embedded browser with the user's
 * own sign-in (the browser keeps its session). Surge reads what the user asks it to summarize —
 * it never posts, likes or messages. This module knows each site's feed URL and the cookie that
 * means "signed in", and can forget a site's sign-in.
 */

export interface Channel {
  id: string;
  name: string;
  /** Where "Open" and "Summarize my feed" go. */
  home: string;
  domain: string;
  /** Any of these cookies on the domain means the user is signed in. */
  sessionCookies: string[];
}

export const CHANNELS: Channel[] = [
  { id: 'instagram', name: 'Instagram', home: 'https://www.instagram.com/', domain: 'instagram.com', sessionCookies: ['sessionid'] },
  { id: 'tiktok', name: 'TikTok', home: 'https://www.tiktok.com/foryou', domain: 'tiktok.com', sessionCookies: ['sessionid', 'sid_tt'] },
  { id: 'x', name: 'X', home: 'https://x.com/home', domain: 'x.com', sessionCookies: ['auth_token'] },
  { id: 'facebook', name: 'Facebook', home: 'https://www.facebook.com/', domain: 'facebook.com', sessionCookies: ['c_user'] },
  { id: 'youtube', name: 'YouTube', home: 'https://www.youtube.com/feed/subscriptions', domain: 'youtube.com', sessionCookies: ['LOGIN_INFO'] },
  { id: 'linkedin', name: 'LinkedIn', home: 'https://www.linkedin.com/feed/', domain: 'linkedin.com', sessionCookies: ['li_at'] },
  { id: 'reddit', name: 'Reddit', home: 'https://www.reddit.com/', domain: 'reddit.com', sessionCookies: ['reddit_session'] },
];

async function signedIn(channel: Channel): Promise<boolean> {
  // The embedded browser uses the default session, so its cookies are the user's sign-ins.
  const cookies = await session.defaultSession.cookies.get({ domain: channel.domain });
  const now = Date.now() / 1000;
  return cookies.some((c) => channel.sessionCookies.includes(c.name) && !!c.value && (!c.expirationDate || c.expirationDate > now));
}

/** Clears every cookie for the channel's domain: the site forgets the sign-in. */
async function forget(channel: Channel): Promise<number> {
  const cookies = await session.defaultSession.cookies.get({ domain: channel.domain });
  for (const c of cookies) {
    const host = (c.domain || channel.domain).replace(/^\./, '');
    await session.defaultSession.cookies.remove(`http${c.secure ? 's' : ''}://${host}${c.path || '/'}`, c.name).catch(() => {});
  }
  return cookies.length;
}

export function registerChannelHandlers(): void {
  ipcMain.handle('channels:list', async () =>
    Promise.all(CHANNELS.map(async (c) => ({ id: c.id, name: c.name, home: c.home, domain: c.domain, signedIn: await signedIn(c) }))));
  ipcMain.handle('channels:forget', async (_e, id: string) => {
    const channel = CHANNELS.find((c) => c.id === id);
    return { cleared: channel ? await forget(channel) : 0 };
  });
}
