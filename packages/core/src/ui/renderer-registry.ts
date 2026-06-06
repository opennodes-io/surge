import type { UiPayload } from './detect-ui-resource.js';

/**
 * Data-only registry of UI renderers, keyed by a string the renderer side maps to a
 * React component. Kept free of React so it can live in core. Plugins/extensions add
 * custom renderers (charts, remote-dom, special mimeTypes) without touching the host.
 */
export interface RendererDescriptor {
  key: string;
  /** Higher runs first. */
  priority?: number;
  match: (payload: UiPayload) => boolean;
}

const registry: RendererDescriptor[] = [];

export function registerUiRenderer(descriptor: RendererDescriptor): void {
  registry.push(descriptor);
  registry.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function clearUiRenderers(): void {
  registry.length = 0;
}

/** Resolve the renderer key for a payload; falls back to the built-in iframe renderers. */
export function resolveRenderer(payload: UiPayload): string {
  for (const d of registry) {
    if (d.match(payload)) return d.key;
  }
  if (payload.kind === 'url') return 'iframe-url';
  if (payload.kind === 'html') return 'iframe-html';
  return 'fallback';
}
