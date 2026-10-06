/**
 * Platform-neutral settings access. The Electron shell's hand-rolled
 * SettingsService satisfies this structurally; a mobile shell can back it with
 * secure storage. Core services depend only on this interface.
 */
export interface SettingsPort {
  get(key: string): any;
  set(key: string, value: any): void;
  /** How many MCP servers may be connected at once (a resource guard, not a plan limit). */
  getMaxConnections(): number;
}
