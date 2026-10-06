/// <reference path="./ollama-router.d.ts" />
import { startOllamaRouter, type OllamaRouter } from '@opennodes/ollama-router';
import type { SettingsService } from './settings-service';

/**
 * Private mode's engine: @opennodes/ollama-router running in this process on a free loopback
 * port with no registry, so it serves only the local Ollama and LAN peers, plus its
 * auto-private advisor model. Nothing it routes leaves the network. LAN discovery over mDNS
 * is opt-in ('private.mdns'): binding UDP 5353 can raise a firewall prompt.
 */
let router: OllamaRouter | null = null;
let starting: Promise<OllamaRouter> | null = null;

export interface PrivateRouterStatus {
  running: boolean;
  origin: string | null;
  ollama: string;
  peers: string[];
  mdns: boolean;
  discoveredPeers: Array<{ name: string; kind: string; origin: string }>;
}

const config = (settings: SettingsService) => ({
  ollama: String(settings.get('ai.ollamaHost') || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  peers: (settings.get('private.peers') as string[] | null) ?? [],
  mdns: settings.get('private.mdns') === true,
});

export async function startPrivateRouter(settings: SettingsService): Promise<string> {
  if (router) return router.origin;
  if (!starting) {
    const { ollama, peers, mdns } = config(settings);
    starting = startOllamaRouter({
      port: 0, host: '127.0.0.1', ollama, peers, registry: null, mdns,
      log: (line) => console.log(line),
    }).finally(() => { starting = null; });
  }
  router = await starting;
  return router.origin;
}

export async function stopPrivateRouter(): Promise<void> {
  const running = router;
  router = null;
  await running?.close();
}

export function privateRouterStatus(settings: SettingsService): PrivateRouterStatus {
  const { ollama, peers, mdns } = config(settings);
  return { running: !!router, origin: router?.origin ?? null, ollama, peers, mdns, discoveredPeers: router?.peers ?? [] };
}
