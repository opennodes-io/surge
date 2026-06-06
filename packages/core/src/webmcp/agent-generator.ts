import { AGENT_ACTIONS, type AgentActionType, type AgentStep, type AgentToolDef, type WebAgentSpec } from './agent-types.js';

/** Minimal AI surface the generator needs (AiService satisfies this). */
export interface AgentGeneratorAi {
  chat(messages: Array<{ role: string; content: string }>, model: string): Promise<{ content: string }>;
}

export interface PageContext {
  url: string;
  domain: string;
  title?: string;
  /** form fields summary: [{selector,type,name,placeholder}] */
  forms?: any;
  /** representative links */
  links?: any;
  headings?: string[];
  /** truncated visible text */
  text?: string;
}

const MAX_TOOLS = 12;
const MAX_STEPS = 20;
const ACTION_SET = new Set<string>(AGENT_ACTIONS);

const SYSTEM_PROMPT = `You design a small "site agent": a set of MCP tools that automate a single website using ONLY a fixed, declarative action vocabulary. You never write code.

Output STRICT JSON (no prose, no markdown fences) of shape:
{
  "name": string,
  "description": string,
  "tools": [
    {
      "name": "snake_case_tool_name",
      "description": string,
      "parameters": { "type": "object", "properties": { "<param>": { "type": "string", "description": string } }, "required": ["<param>"] },
      "steps": [ { "action": <action>, ... } ]
    }
  ]
}

Allowed actions and their fields (selectors are CSS):
- navigate: { "url": "https://... (use {param} to insert a tool parameter)" }
- waitFor: { "selector": "css", "timeoutMs"?: number }
- fill: { "selector": "css", "valueFromParam": "<param>" }  // or "value": "literal or {param}"
- click: { "selector": "css" }
- select: { "selector": "css", "valueFromParam": "<param>" }
- pressKey: { "selector"?: "css", "key": "Enter" }
- extractText: { "selector": "css", "saveAs": "fieldName" }
- extractTable: { "selector": "table css", "saveAs": "fieldName" }
- extractLinks: { "selector"?: "css scope", "saveAs": "fieldName" }
- extractAttribute: { "selector": "css", "attribute": "href", "saveAs": "fieldName" }

Rules: prefer 1-4 focused tools. Every extract step MUST set saveAs. Use {param} templating in url/value for tool parameters. Use real selectors inferred from the page context. Do NOT invent an action outside the list. Output JSON only.`;

function buildUserPrompt(ctx: PageContext): string {
  return [
    `Design a site agent for: ${ctx.domain}`,
    `URL: ${ctx.url}`,
    ctx.title ? `Title: ${ctx.title}` : '',
    ctx.headings?.length ? `Headings: ${ctx.headings.slice(0, 15).join(' | ')}` : '',
    ctx.forms ? `Form fields: ${JSON.stringify(ctx.forms).slice(0, 1500)}` : '',
    ctx.links ? `Sample links: ${JSON.stringify(ctx.links).slice(0, 1000)}` : '',
    ctx.text ? `Visible text (truncated): ${ctx.text.slice(0, 1500)}` : '',
    '',
    'Return the agent JSON now.',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const s = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function sanitizeName(name: unknown, fallback: string): string {
  const raw = s(name, fallback).trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return cleaned || fallback;
}

function sanitizeStep(raw: any): AgentStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const action = s(raw.action) as AgentActionType;
  if (!ACTION_SET.has(action)) return null;
  const step: AgentStep = { action };
  if (raw.selector != null) step.selector = s(raw.selector).slice(0, 400);
  if (raw.url != null) step.url = s(raw.url).slice(0, 1000);
  if (raw.value != null) step.value = s(raw.value).slice(0, 1000);
  if (raw.valueFromParam != null) step.valueFromParam = sanitizeName(raw.valueFromParam, 'param');
  if (raw.attribute != null) step.attribute = s(raw.attribute).slice(0, 64);
  if (raw.key != null) step.key = s(raw.key).slice(0, 32);
  if (raw.saveAs != null) step.saveAs = sanitizeName(raw.saveAs, 'result');
  if (typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0) step.timeoutMs = Math.min(raw.timeoutMs, 30000);
  return step;
}

function sanitizeTool(raw: any, index: number): AgentToolDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = sanitizeName(raw.name, `tool_${index}`);
  const props: Record<string, { type: string; description?: string }> = {};
  const rawProps = raw.parameters?.properties;
  if (rawProps && typeof rawProps === 'object') {
    for (const [k, v] of Object.entries(rawProps).slice(0, 8)) {
      props[sanitizeName(k, 'param')] = { type: s((v as any)?.type, 'string') || 'string', description: s((v as any)?.description) };
    }
  }
  const required = Array.isArray(raw.parameters?.required)
    ? raw.parameters.required.map((r: any) => sanitizeName(r, 'param')).filter((r: string) => r in props)
    : [];
  const steps = Array.isArray(raw.steps)
    ? (raw.steps.slice(0, MAX_STEPS).map(sanitizeStep).filter(Boolean) as AgentStep[])
    : [];
  if (steps.length === 0) return null; // never accept a code-bearing or empty tool from generation
  return {
    name,
    description: s(raw.description, name).slice(0, 300),
    parameters: { type: 'object', properties: props, required },
    steps,
    // NOTE: `code` is intentionally never copied from generated output.
  };
}

/**
 * Sanitize untrusted (LLM-produced) agent JSON into a safe declarative WebAgentSpec.
 * This is the security gate: only whitelisted actions survive, counts are capped, and
 * any `code` field is dropped. codeApproved is always false here.
 */
export function sanitizeAgentSpec(raw: any, domain: string): WebAgentSpec {
  const toolsRaw = Array.isArray(raw?.tools) ? raw.tools.slice(0, MAX_TOOLS) : [];
  const tools = toolsRaw.map((t: any, i: number) => sanitizeTool(t, i)).filter(Boolean) as AgentToolDef[];
  return {
    version: 1,
    source: 'web-mcp',
    domain,
    name: s(raw?.name, `${domain} agent`).slice(0, 80),
    description: s(raw?.description).slice(0, 400),
    tools,
    codeApproved: false,
  };
}

/** Generate a declarative site agent from page context. Returns a sanitized, unsaved proposal. */
export async function generateAgentSpec(ai: AgentGeneratorAi, model: string, ctx: PageContext): Promise<WebAgentSpec> {
  const res = await ai.chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    model,
  );
  const parsed = extractJson(res.content || '');
  if (!parsed) {
    return { version: 1, source: 'web-mcp', domain: ctx.domain, name: `${ctx.domain} agent`, tools: [], codeApproved: false };
  }
  return sanitizeAgentSpec(parsed, ctx.domain);
}
