export type Tier = 'free' | 'pro' | 'enterprise';

/**
 * Platform-neutral settings access. The Electron shell's hand-rolled
 * SettingsService satisfies this structurally; a mobile shell can back it with
 * secure storage. Core services depend only on this interface.
 */
export interface SettingsPort {
  get(key: string): any;
  set(key: string, value: any): void;
  getTier(): Tier;
  getMaxConnections(): number;
  isFeatureAvailable?(feature: string): boolean;
  checkSearchQuota?(): boolean;
  incrementSearchCount?(): void;
}
