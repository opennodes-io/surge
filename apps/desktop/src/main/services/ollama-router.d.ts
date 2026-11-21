// Ambient types for @opennodes/ollama-router 0.1.27 (plain ESM JavaScript, no .d.ts); only what
// the private-mode service uses.
declare module '@opennodes/ollama-router' {
  export interface OllamaRouterPeer {
    name: string;
    kind: 'ollama' | 'onp';
    origin: string;
    /** Whether its card verified against a pinned key at the origin the card names (ONP-3 §5b). */
    pinned?: boolean;
    source?: 'added' | 'mdns';
  }

  export interface OllamaRouter {
    port: number;
    origin: string;
    /**
     * The bearer token for the router's own API (/router/*: peers, catalog, receipts, advice) and for
     * requests from other machines. The model routes serve local apps without it. A new one each run
     * unless `token` was passed.
     */
    token: string;
    readonly peers: OllamaRouterPeer[];
    /** Nodes found over mDNS but not pinned: listed, never used. */
    readonly discovered: Array<{ origin: string; kind: string; node_id: string | null }>;
    addPeer(origin: string, opts?: { pin?: string | null }): Promise<OllamaRouterPeer | null>;
    close(): Promise<void>;
  }

  export function startOllamaRouter(opts?: {
    port?: number;
    host?: string;
    ollama?: string;                // the local Ollama origin
    peers?: string[];               // LAN Ollama servers or ONP nodes
    pins?: string[];                // RFC 7638 thumbprints of LAN node card keys that are the user's own network
    token?: string | null;          // null on loopback: a new token per run
    allowOrigins?: string[];        // browser origins besides local pages that may use the model routes
    allowHosts?: string[];          // Host names besides loopback ones that local apps may use
    registry?: string | null;       // null = LAN only (no public tier)
    policy?: Record<string, unknown>;
    keys?: Record<string, string>;
    ledgerPath?: string | null;
    reputationPath?: string | null; // null = this run only
    mdns?: boolean;
    log?: (line: string) => void;
  }): Promise<OllamaRouter>;
}
