// Typed client for an OpenNodes (ONP) registry — model/inference-endpoint discovery,
// the sibling of discovery/ (which browses MCP_Index for tool servers). REST because
// the registry returns structured trust data — tier, measured latency/throughput,
// rank explanations, capped context — that a rich model picker needs.
// Registry API: https://github.com/opennodes-io/opennodes (ONP-3).

/** The hosted OpenNodes registry (web app + /v0 API + /mcp). A local one: `npx @opennodes/registry` on :4300. */
export const ONP_DEFAULT_REGISTRY = 'https://registry.opennodes.io';

/** Registry search can stall (captive portal, half-open connection); never let it block the model picker. */
const SEARCH_TIMEOUT_MS = 8_000;

export type OnpTier = 'verified' | 'community' | 'unverified' | 'disputed' | 'suspended';

export interface OnpOffering {
  /** stable key: `${nodeId}/${offeringId}` */
  key: string;
  nodeId: string;
  offeringId: string;
  modelName: string;
  artifact: string;               // hf:{org}/{repo} or urn:proprietary:{vendor}:{model}
  family?: string;
  paramsB?: number;
  description?: string;
  modality: string;
  tier: OnpTier;
  source: 'registration' | 'import';
  institutional: boolean;
  /** locally-runnable entry (e.g. Ollama library): run command + pulls */
  local?: { runtime: string; run: string; pulls?: string; sizes?: string[] } | null;
  endpointBase: string;           // OpenAI-compatible base URL of the serving node
  bindingModelId: string;         // the `model` value to send on the wire
  cardRevision: string;           // pin this at invocation — makes the price enforceable
  pricing: { currency: string; inputPerMtok: number; outputPerMtok: number; schemes: string[] };
  contextWindow?: number;
  contextCappedFrom?: number;     // registry capped an overclaimed window — trust signal
  supports: string[];             // tool_calls, json_mode, vision, streaming
  measured: { ttftMsP50?: number; tps?: number; availability?: number };
  rank?: number;
  rankExplanation?: { weights: Record<string, number>; components: Record<string, number> };
}

export interface OnpSearchQuery {
  search?: string;
  modality?: string;
  tier?: 'community' | 'verified';
  supports?: string[];
  maxInputPrice?: number;
  lang?: string;                  // e.g. "en:strong"
  sort?: 'rank' | 'price';
  limit?: number;
}

export interface OnpEstimateStep {
  offering?: string;              // "nodeId/offeringId"
  select?: Record<string, string>;
  est_input_tokens?: number;
  est_output_tokens?: number;
}

export interface OnpEstimate {
  total: { currency: string; min: number; max: number };
  steps: Array<{ offering: string; card_revision: string; cost: { currency: string; min: number; max: number } }>;
}

function normalize(o: any): OnpOffering {
  return {
    key: `${o.node_id}/${o.offering_id}`,
    nodeId: o.node_id,
    offeringId: o.offering_id,
    modelName: o.model?.name ?? o.offering_id,
    artifact: o.model?.artifact ?? '',
    family: o.model?.family ?? undefined,
    paramsB: o.model?.params_b ?? undefined,
    description: o.model?.description ?? undefined,
    modality: o.modality,
    tier: (o.tier ?? 'unverified') as OnpTier,
    source: o.source === 'import' ? 'import' : 'registration',
    institutional: Boolean(o.institutional),
    local: o.local ?? null,
    endpointBase: String(o.endpoints?.openai ?? '').replace(/\/+$/, ''),
    bindingModelId: o.binding?.model_id ?? o.offering_id,
    cardRevision: o.card_revision ?? '',
    pricing: {
      currency: o.pricing?.currency ?? 'USD',
      inputPerMtok: o.pricing?.input_per_mtok ?? 0,
      outputPerMtok: o.pricing?.output_per_mtok ?? 0,
      schemes: o.pricing?.schemes ?? [],
    },
    contextWindow: o.serving?.context_window ?? undefined,
    contextCappedFrom: o.serving?.context_capped_from ?? undefined,
    supports: o.serving?.supports ?? [],
    measured: {
      ttftMsP50: o.observed?.ttft_ms?.p50 ?? undefined,
      tps: o.observed?.tps > 0 ? o.observed.tps : undefined,
      availability: o.observed?.availability?.ratio ?? undefined,
    },
    rank: o.rank ?? undefined,
    rankExplanation: o.rank_explanation ?? undefined,
  };
}

export class OnpRegistryClient {
  private baseUrl: string;

  constructor(baseUrl = ONP_DEFAULT_REGISTRY) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async searchOfferings(query: OnpSearchQuery = {}): Promise<OnpOffering[]> {
    const p = new URLSearchParams();
    if (query.search) p.set('q', query.search);
    if (query.modality) p.set('modality', query.modality);
    if (query.tier) p.set('tier', query.tier);
    if (query.supports?.length) p.set('supports', query.supports.join(','));
    if (query.maxInputPrice != null) p.set('max_input_price', String(query.maxInputPrice));
    if (query.lang) p.set('lang', query.lang);
    p.set('sort', query.sort ?? 'rank');
    p.set('limit', String(query.limit ?? 50));
    const res = await fetch(`${this.baseUrl}/v0/offerings?${p}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ONP registry search failed: ${res.status}`);
    const body: any = await res.json();
    return (body.offerings ?? []).map(normalize);
  }

  async getNode(nodeId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/v0/nodes/${encodeURIComponent(nodeId)}`);
    if (!res.ok) throw new Error(`ONP node lookup failed: ${res.status}`);
    return res.json();
  }

  /** Pre-price an invocation chain; the returned card_revisions make the estimate enforceable. */
  async estimate(steps: OnpEstimateStep[]): Promise<OnpEstimate> {
    const res = await fetch(`${this.baseUrl}/v0/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps }),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(body?.detail ?? `ONP estimate failed: ${res.status}`);
    return body as OnpEstimate;
  }
}
