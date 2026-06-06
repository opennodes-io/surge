import React, { useState, useMemo, useEffect } from 'react';
import { IconCircle, IconCheck, IconX } from './Icons';
import McpAppRenderer, { type HostAction } from './McpAppRenderer';
import { detectUiResource, type UiPayload } from '@surge/core/ui';
import './McpToolCallBlock.css';

interface ToolCallData {
  id: string;
  serverId: string;
  serverName?: string;
  toolName: string;
  args: any;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: any;
  durationMs?: number;
}

interface McpToolCallBlockProps {
  data: ToolCallData;
}

// ── Rich Content Renderers ──────────────────────────────

// Detect if data is tabular (array of objects with consistent keys)
function detectTable(data: any): { isTable: boolean; headers: string[]; rows: any[][] } {
  if (!Array.isArray(data) || data.length === 0) return { isTable: false, headers: [], rows: [] };
  // All items must be plain objects with at least one key
  const allObjects = data.every(
    (item: any) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0
  );
  if (!allObjects) return { isTable: false, headers: [], rows: [] };
  // Collect all unique keys across all rows
  const headerSet = new Set<string>();
  data.forEach((item: any) => Object.keys(item).forEach(k => headerSet.add(k)));
  const headers = Array.from(headerSet);
  // Require at least 2 columns and 1 row for a meaningful table
  if (headers.length < 2 || data.length < 1) return { isTable: false, headers: [], rows: [] };
  const rows = data.map((item: any) => headers.map(h => item[h]));
  return { isTable: true, headers, rows };
}

// Detect images in MCP content array
function extractImages(content: any): { src: string; alt: string; mimeType: string }[] {
  if (!content) return [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c.type === 'image')
    .map((c: any) => ({
      src: c.data
        ? `data:${c.mimeType || 'image/png'};base64,${c.data}`
        : c.url || '',
      alt: c.alt || c.title || 'Tool result image',
      mimeType: c.mimeType || 'image/png',
    }))
    .filter((img: any) => img.src);
}

// Extract text content from MCP content array
function extractText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

// Parse text content to detect embedded JSON with tabular data
function parseJsonFromText(text: string): any | null {
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    // Try to find JSON embedded in text
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch { /* not JSON */ }
    }
    return null;
  }
}

// Extract MCP UI hints from result
interface McpUiHints {
  display?: 'table' | 'chart' | 'image' | 'card' | 'list';
  title?: string;
  columns?: { key: string; label: string; format?: string }[];
  chartType?: string;
}

function extractUiHints(result: any): McpUiHints {
  if (!result) return {};
  // Check for _ui or ui_hints field in result
  if (typeof result === 'object' && !Array.isArray(result)) {
    return result._ui || result.ui_hints || result.mcpui || {};
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item?.type === 'ui_hints' || item?.type === '_ui') {
        return item.data || item;
      }
    }
  }
  return {};
}

// ── Table Renderer ──────────────────────────────────────
const RichTable: React.FC<{ headers: string[]; rows: any[][]; uiHints: McpUiHints }> = ({ headers, rows, uiHints }) => {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const displayHeaders = useMemo(() => {
    if (uiHints.columns) {
      return headers.map(h => {
        const col = uiHints.columns!.find(c => c.key === h);
        return col?.label || h;
      });
    }
    // Auto-prettify: capitalize, replace underscores
    return headers.map(h => h.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  }, [headers, uiHints]);

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }, [rows, sortCol, sortAsc]);

  const handleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(colIdx);
      setSortAsc(true);
    }
  };

  const formatCell = (value: any, colIdx: number): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    // Check for format hints
    if (uiHints.columns) {
      const col = uiHints.columns.find(c => c.key === headers[colIdx]);
      if (col?.format === 'currency' && typeof value === 'number') return `$${value.toLocaleString()}`;
      if (col?.format === 'percent' && typeof value === 'number') return `${(value * 100).toFixed(1)}%`;
      if (col?.format === 'date' && value) return new Date(value).toLocaleDateString();
    }
    // Auto-detect: numbers with commas
    if (typeof value === 'number') return value.toLocaleString();
    return String(value);
  };

  return (
    <div className="tcb-table-wrapper">
      {uiHints.title && <div className="tcb-table-title">{uiHints.title}</div>}
      <table className="tcb-table">
        <thead>
          <tr>
            {displayHeaders.map((h, i) => (
              <th key={i} onClick={() => handleSort(i)} className="tcb-th">
                {h}
                {sortCol === i && <span className="tcb-sort">{sortAsc ? ' ▲' : ' ▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'tcb-row-even' : 'tcb-row-odd'}>
              {row.map((cell, ci) => (
                <td key={ci} className="tcb-td">{formatCell(cell, ci)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tcb-table-footer">{rows.length} row{rows.length !== 1 ? 's' : ''}</div>
    </div>
  );
};

// ── Image Renderer ──────────────────────────────────────
const RichImage: React.FC<{ src: string; alt: string }> = ({ src, alt }) => {
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <>
      <div className="tcb-image-wrapper" onClick={() => setFullscreen(true)}>
        <img src={src} alt={alt} className="tcb-image" />
        <div className="tcb-image-overlay">Click to expand</div>
      </div>
      {fullscreen && (
        <div className="tcb-image-fullscreen" onClick={() => setFullscreen(false)}>
          <img src={src} alt={alt} />
          <div className="tcb-image-close">✕ Close</div>
        </div>
      )}
    </>
  );
};

// ── Main Component ──────────────────────────────────────
const McpToolCallBlock: React.FC<McpToolCallBlockProps> = ({ data }) => {
  const [expanded, setExpanded] = useState(false);

  // ── MCP Apps / MCP-UI detection ──
  const uiPayload: UiPayload | null = useMemo(
    () => (data.status === 'success' ? detectUiResource(data.result, data.serverId) : null),
    [data.result, data.status, data.serverId],
  );

  // Apps-SDK templates carry a ui:// uri but no inline HTML — fetch it via readResource.
  const [resourceHtml, setResourceHtml] = useState<string | null>(null);
  useEffect(() => {
    setResourceHtml(null);
    if (uiPayload && uiPayload.kind === 'html' && !uiPayload.html && uiPayload.resourceUri && data.serverId) {
      let cancelled = false;
      window.surge.mcp
        .readResource(data.serverId, uiPayload.resourceUri)
        .then((res: any) => {
          const text = res?.contents?.[0]?.text;
          if (!cancelled && typeof text === 'string') setResourceHtml(text);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [uiPayload, data.serverId]);

  const handleHostAction = (action: HostAction) => {
    switch (action.type) {
      case 'tool':
        if (action.payload.toolName) {
          window.surge.mcp
            .callTool(action.payload.serverId || data.serverId, action.payload.toolName, action.payload.params || {})
            .catch(() => {});
        }
        break;
      case 'prompt':
        if (action.payload.text) window.dispatchEvent(new CustomEvent('surge:prompt', { detail: action.payload.text }));
        break;
      case 'link':
        if (action.payload.url) window.surge.browser.openExternal(action.payload.url);
        break;
      case 'notify':
        console.info('[MCP App]', action.payload.message);
        break;
    }
  };

  const uiHtml = uiPayload?.html ?? resourceHtml ?? undefined;
  const hasUiApp = !!uiPayload && (uiPayload.kind === 'url' || !!uiHtml);

  // Parse result into rich content
  const richContent = useMemo(() => {
    if (!data.result || data.status === 'error') return null;

    const result = data.result;
    const uiHints = extractUiHints(result);
    const images = extractImages(result);
    const text = extractText(result);

    // Try to find tabular data
    let tableData = detectTable(result);

    // If result is a content array, check text items for JSON
    if (!tableData.isTable && text) {
      const parsed = parseJsonFromText(text);
      if (parsed) {
        // Check if parsed JSON itself is tabular
        tableData = detectTable(parsed);
        // Or if it has a data/results/rows field that's tabular
        if (!tableData.isTable && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const key of ['data', 'results', 'rows', 'items', 'records', 'entries']) {
            if (Array.isArray(parsed[key])) {
              tableData = detectTable(parsed[key]);
              if (tableData.isTable) break;
            }
          }
        }
      }
    }

    // UI hints can force display mode
    if (uiHints.display === 'table' && !tableData.isTable) {
      // Try harder to make a table from the data
      if (typeof result === 'object' && !Array.isArray(result)) {
        const keys = Object.keys(result).filter(k => k !== '_ui' && k !== 'ui_hints' && k !== 'mcpui');
        if (keys.length > 0) {
          tableData = { isTable: true, headers: ['Field', 'Value'], rows: keys.map(k => [k, result[k]]) };
        }
      }
    }

    return { images, text, tableData, uiHints };
  }, [data.result, data.status]);

  const hasRichContent = richContent && (
    richContent.images.length > 0 || richContent.tableData.isTable
  );

  const statusIcon = () => {
    switch (data.status) {
      case 'pending': return <IconCircle size={14} className="tcb-status-icon pending" />;
      case 'running': return <div className="spinner spinner-sm"></div>;
      case 'success': return <IconCheck size={14} className="tcb-status-icon success status-pop" />;
      case 'error': return <IconX size={14} className="tcb-status-icon error status-pop" />;
    }
  };

  const formatContent = (content: any): string => {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c: any) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[Image: ${c.mimeType || 'image'}]`;
        return JSON.stringify(c);
      }).join('\n');
    }
    return JSON.stringify(content, null, 2);
  };

  return (
    <div className={`tcb ${data.status}`}>
      <div className="tcb-header" onClick={() => setExpanded(!expanded)}>
        <div className="tcb-left">
          {statusIcon()}
          <span className="tcb-server badge badge-cyan">{data.serverName || data.serverId}</span>
          <span className="tcb-tool-name">{data.toolName}</span>
          {hasRichContent && (
            <span className="badge badge-purple" style={{ fontSize: '0.55rem' }}>
              {richContent!.images.length > 0 && '🖼️'}
              {richContent!.tableData.isTable && '📊'}
            </span>
          )}
        </div>
        <div className="tcb-right">
          {data.durationMs !== undefined && (
            <span className="tcb-duration badge badge-green">{data.durationMs}ms</span>
          )}
          <span className="tcb-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* MCP App / MCP-UI interactive surface */}
      {hasUiApp && data.status === 'success' && (
        <div className="tcb-rich-preview">
          <McpAppRenderer
            htmlContent={uiHtml}
            url={uiPayload!.kind === 'url' ? uiPayload!.url : undefined}
            toolName={data.toolName}
            serverName={data.serverName}
            serverId={data.serverId}
            onHostAction={handleHostAction}
          />
        </div>
      )}

      {/* Rich content preview — shown even when collapsed */}
      {!hasUiApp && hasRichContent && data.status === 'success' && (
        <div className="tcb-rich-preview">
          {/* Images */}
          {richContent!.images.map((img, i) => (
            <RichImage key={`img-${i}`} src={img.src} alt={img.alt} />
          ))}

          {/* Table */}
          {richContent!.tableData.isTable && (
            <RichTable
              headers={richContent!.tableData.headers}
              rows={richContent!.tableData.rows}
              uiHints={richContent!.uiHints}
            />
          )}
        </div>
      )}

      {expanded && (
        <div className="tcb-details fade-in">
          <div className="tcb-section">
            <div className="tcb-section-label">Arguments</div>
            <pre className="tcb-code">
              <code>{JSON.stringify(data.args, null, 2)}</code>
            </pre>
          </div>

          {data.result && (
            <div className="tcb-section">
              <div className="tcb-section-label">Raw Result</div>
              <pre className={`tcb-code ${data.status === 'error' ? 'error' : ''}`}>
                <code>{formatContent(data.result)}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default McpToolCallBlock;
export type { ToolCallData };
