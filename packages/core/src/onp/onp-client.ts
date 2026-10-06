// Typed client for an OpenNodes (ONP) registry — model/inference-endpoint discovery,
// the sibling of discovery/ (which browses MCP_Index for tool servers). REST because
// the registry returns structured trust data — tier, measured latency/throughput,
// rank explanations, capped context — that a rich model picker needs.
// Registry API: https://github.com/opennodes-io/opennodes (ONP-3).

/** The hosted OpenNodes registry (web app + /v0 API + /mcp). A local one: `npx @opennodes/registry` on :4300. */
export const ONP_DEFAULT_REGISTRY = 'https://registry.opennodes.io';

/** Registry/node fetches can stall (captive portal, half-open connection); never let them block the UI. */
export const ONP_FETCH_TIMEOUT_MS = 8_000;

/** Registry tiers, plus the client-side `local` / `lan` tiers (your own machines, fully trusted). */
export type OnpTier = 'attested' | 'verified' | 'community' | 'unverified' | 'disputed' | 'suspended' | 'local' | 'lan';

export interface OnpPricing { currency: string; inputPerMtok: number; outputPerMtok: number; schemes: string[] }

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
  pricing: OnpPricing;
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
  tier?: 'community' | 'verified' | 'attested'; // minimum tier
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

function normalizePricing(p: any): OnpPricing {
  return {
    currency: p?.currency ?? 'USD',
    inputPerMtok: p?.input_per_mtok ?? 0,
    outputPerMtok: p?.output_per_mtok ?? 0,
    schemes: p?.schemes ?? [],
  };
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
    pricing: normalizePricing(o.pricing),
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
    const res = await fetch(`${this.baseUrl}/v0/offerings?${p}`, { signal: AbortSignal.timeout(ONP_FETCH_TIMEOUT_MS) });
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

/**
 * Re-resolve an offering's current revision and price from the node's own card
 * (`{origin}/.well-known/open-node.json`, ONP-2) — the ground truth after a 409 price_changed;
 * the registry may still be indexing the old revision. Returns null when the node no longer
 * lists the offering. Card signature verification arrives with @opennodes/core.
 */
export async function resolveCardOffering(
  offering: Pick<OnpOffering, 'endpointBase' | 'nodeId' | 'offeringId'>,
): Promise<{ cardRevision: string; pricing: OnpPricing } | null> {
  const origin = new URL(offering.endpointBase).origin;
  const res = await fetch(`${origin}/.well-known/open-node.json`, { signal: AbortSignal.timeout(ONP_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ONP card fetch from ${origin} failed: ${res.status}`);
  const card: any = await res.json();
  if (card.node?.id && card.node.id !== offering.nodeId) {
    throw new Error(`ONP card at ${origin} is for ${card.node.id}, not ${offering.nodeId}`);
  }
  const fresh = (card.offerings ?? []).find((o: any) => o.offering_id === offering.offeringId);
  if (!fresh || !card.revision) return null;
  return { cardRevision: String(card.revision), pricing: normalizePricing(fresh.pricing) };
}

/** True when `next` costs more than `prev` on either side, or is in another currency. */
export function onpPriceRaised(prev: OnpPricing, next: OnpPricing): boolean {
  return next.currency !== prev.currency
    || next.inputPerMtok > prev.inputPerMtok
    || next.outputPerMtok > prev.outputPerMtok;
}

export function formatOnpPrice(p: OnpPricing): string {
  if (p.inputPerMtok === 0 && p.outputPerMtok === 0) return 'Free';
  const sym = p.currency === 'USD' ? '$' : `${p.currency} `;
  return `${sym}${p.inputPerMtok}/${sym}${p.outputPerMtok} per MTok`;
}
