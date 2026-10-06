// Ambient types for @opennodes/ollama-router 0.1.2 (plain ESM JavaScript, no .d.ts); only what
// the private-mode service uses.
declare module '@opennodes/ollama-router' {
  export interface OllamaRouter {
    port: number;
    origin: string;
    readonly peers: Array<{ name: string; kind: 'ollama' | 'onp'; origin: string }>;
    addPeer(origin: string): Promise<{ name: string; kind: string; origin: string } | null>;
    close(): Promise<void>;
  }

  export function startOllamaRouter(opts?: {
    port?: number;
    host?: string;
    ollama?: string;                // the local Ollama origin
    peers?: string[];               // LAN Ollama servers or ONP nodes
    registry?: string | null;       // null = LAN only (no public tier)
    policy?: Record<string, unknown>;
    keys?: Record<string, string>;
    ledgerPath?: string | null;
    mdns?: boolean;
    log?: (line: string) => void;
  }): Promise<OllamaRouter>;
}
