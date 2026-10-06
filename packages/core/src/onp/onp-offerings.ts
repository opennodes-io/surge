// The OpenNodes offering model: types, registry-record normalization and price helpers.
// Platform-agnostic (no Node APIs, no @opennodes packages), so receipts and the spend policy
// that build on it stay usable from the mobile shell and browsers too.

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
  /** The registry record as returned (snake_case) — what the advisor ranks. */
  raw: Record<string, any>;
}

export function normalizePricing(p: any): OnpPricing {
  return {
    currency: p?.currency ?? 'USD',
    inputPerMtok: p?.input_per_mtok ?? 0,
    outputPerMtok: p?.output_per_mtok ?? 0,
    schemes: p?.schemes ?? [],
  };
}

/** Map a /v0/offerings record onto OnpOffering. */
export function normalizeOffering(o: any): OnpOffering {
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
    raw: o,
  };
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
