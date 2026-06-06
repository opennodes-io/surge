// Normalises an MCP tool result into a renderable UI payload, supporting:
//  - mcp-ui: an embedded resource block { type:'resource', resource:{ uri:'ui://...', mimeType, text|blob } }
//  - MCP Apps / Apps SDK: a result _meta template (e.g. openai/outputTemplate) pointing at a ui:// resource
//    that the host fetches via readResource
//  - legacy structured hints (_ui / ui_hints) handled separately by the table renderer

export type UiKind = 'html' | 'url' | 'remote-dom';
export type UiType = 'mcp-ui' | 'mcp-apps';

export interface UiPayload {
  kind: UiKind;
  /** inline HTML to render (kind 'html') */
  html?: string;
  /** external URL to load in an iframe (kind 'url') */
  url?: string;
  mimeType?: string;
  uiType?: UiType;
  /** the ui:// resource uri, when the HTML must be fetched via readResource (Apps SDK) */
  resourceUri?: string;
  /** server that produced this, for the host->server tool bridge */
  serverId?: string;
  preferredHeight?: number;
}

function decodeResourceText(resource: any): string | undefined {
  if (typeof resource?.text === 'string') return resource.text;
  if (typeof resource?.blob === 'string') {
    try {
      // base64 blob -> utf8
      return typeof atob === 'function'
        ? atob(resource.blob)
        : Buffer.from(resource.blob, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asContentArray(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.content)) return result.content;
  return [];
}

/**
 * Inspect a tool result (raw MCP content array, or a CallToolResult-shaped object)
 * and return a UiPayload if it carries renderable UI, else null.
 */
export function detectUiResource(result: any, serverId?: string): UiPayload | null {
  if (!result || typeof result === 'string') return null;

  // 1) Apps SDK / MCP Apps: result-level _meta output template (ui:// resource fetched later).
  const meta = result?._meta ?? result?.meta;
  if (meta && typeof meta === 'object') {
    const tmpl =
      meta['openai/outputTemplate'] ||
      meta['mcp/outputTemplate'] ||
      meta['ui/template'] ||
      meta.outputTemplate;
    if (typeof tmpl === 'string' && tmpl.startsWith('ui://')) {
      return { kind: 'html', uiType: 'mcp-apps', resourceUri: tmpl, serverId };
    }
  }

  // 2) mcp-ui: an embedded resource block.
  for (const block of asContentArray(result)) {
    if (block?.type !== 'resource' || !block.resource) continue;
    const res = block.resource;
    const uri: string = res.uri || '';
    const mimeType: string = res.mimeType || '';
    const isUiScheme = uri.startsWith('ui://');

    if (mimeType.includes('remote-dom') || mimeType.includes('vnd.mcp-ui.remote-dom')) {
      // remote-dom isn't rendered yet — let the caller fall back to text/table.
      return null;
    }
    if (mimeType === 'text/uri-list') {
      const text = decodeResourceText(res) || '';
      const url = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (url) return { kind: 'url', url, mimeType, uiType: 'mcp-ui', resourceUri: uri, serverId };
    }
    if (mimeType === 'text/html' || (isUiScheme && !mimeType)) {
      const html = decodeResourceText(res);
      if (html) return { kind: 'html', html, mimeType: 'text/html', uiType: 'mcp-ui', resourceUri: uri, serverId };
    }
  }

  return null;
}
