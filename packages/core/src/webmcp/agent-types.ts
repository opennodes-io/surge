// Strict types for generated per-site web agents.
//
// SECURITY MODEL: an agent tool is a *declarative recipe* — an ordered list of
// whitelisted browser actions whose selectors/values are treated as DATA (never code).
// The LLM generator only ever emits this declarative form; it cannot emit code.
// An optional, opt-in `code` handler exists for advanced cases but runs ONLY in the
// gated worker/vm sandbox after explicit per-agent approval (codeApproved === true).

export const AGENT_ACTIONS = [
  'navigate',
  'waitFor',
  'fill',
  'click',
  'select',
  'pressKey',
  'extractText',
  'extractTable',
  'extractLinks',
  'extractAttribute',
] as const;

export type AgentActionType = (typeof AGENT_ACTIONS)[number];

export interface AgentStep {
  action: AgentActionType;
  /** CSS selector the action targets (data, JSON-injected — never evaluated as code). */
  selector?: string;
  /** URL for `navigate` (may contain {paramName} templates). */
  url?: string;
  /** literal value for fill/select (may contain {paramName} templates). */
  value?: string;
  /** take the value from a named tool input parameter instead of `value`. */
  valueFromParam?: string;
  /** attribute name for extractAttribute. */
  attribute?: string;
  /** key for pressKey (e.g. "Enter"). */
  key?: string;
  /** store this step's extraction result under this key in the tool output. */
  saveAs?: string;
  timeoutMs?: number;
}

export interface AgentParamSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: AgentParamSchema;
  /** Declarative recipe (preferred / safe). */
  steps?: AgentStep[];
  /**
   * Opt-in arbitrary-code handler body. Receives `input` (args) and `page` (read-only
   * page text); must return a JSON-able value. Runs ONLY in the gated sandbox when the
   * agent's codeApproved flag is true. Generators never produce this.
   */
  code?: string;
}

export interface WebAgentSpec {
  version: 1;
  source: 'web-mcp' | 'codegen';
  domain: string;
  name: string;
  description?: string;
  tools: AgentToolDef[];
  /** must be explicitly set true by the user to allow any `code`-based tool to run */
  codeApproved?: boolean;
}

export function agentServerId(domain: string): string {
  return `agent:${domain}`;
}

/** True if any tool uses the opt-in arbitrary-code path. */
export function specUsesCode(spec: WebAgentSpec): boolean {
  return spec.tools.some((t) => typeof t.code === 'string' && t.code.trim().length > 0);
}
