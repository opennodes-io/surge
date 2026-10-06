/// <reference path="./opennodes.d.ts" />
// OpenNodes (ONP) registry access — model/inference-endpoint discovery, the sibling of
// discovery/ (which browses MCP_Index for tool servers) — over the published @opennodes/cli
// OnpClient. This module adds the typed OnpOffering view, timeouts, and node-card resolution.
// Node-only (the package uses node:crypto/fs): keep it behind the onp/ai subpaths.
// Registry API: https://github.com/opennodes-io/opennodes (ONP-3).
import { OnpClient } from '@opennodes/cli';
import {
  ONP_DEFAULT_REGISTRY, ONP_FETCH_TIMEOUT_MS, normalizeOffering, normalizePricing,
  type OnpOffering, type OnpPricing,
} from './onp-offerings.js';

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

// OnpClient's fetches take no AbortSignal: the timeout frees the caller (the model picker, a
// 409 retry) while the request itself finishes or fails in the background.
function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ONP_FETCH_TIMEOUT_MS / 1000}s`)), ONP_FETCH_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class OnpRegistryClient {
  private client: OnpClient;

  constructor(baseUrl = ONP_DEFAULT_REGISTRY) {
    this.client = new OnpClient({ registry: baseUrl.replace(/\/+$/, '') });
  }

  async searchOfferings(query: OnpSearchQuery = {}): Promise<OnpOffering[]> {
    const p: Record<string, string> = {};
    if (query.search) p.q = query.search;
    if (query.modality) p.modality = query.modality;
    if (query.tier) p.tier = query.tier;
    if (query.supports?.length) p.supports = query.supports.join(',');
    if (query.maxInputPrice != null) p.max_input_price = String(query.maxInputPrice);
    if (query.lang) p.lang = query.lang;
    p.sort = query.sort ?? 'rank';
    p.limit = String(query.limit ?? 50);
    const offerings = await withTimeout(this.client.search(p), 'ONP registry search');
    return (offerings ?? []).map(normalizeOffering);
  }

  /** Pre-price an invocation chain; the returned card_revisions make the estimate enforceable. */
  async estimate(steps: OnpEstimateStep[]): Promise<OnpEstimate> {
    return withTimeout(this.client.estimate(steps), 'ONP estimate');
  }

  /**
   * Re-resolve an offering's current revision and price from the node's own card
   * (`{origin}/.well-known/open-node.json`, ONP-2) — the ground truth after a 409 price_changed;
   * the registry may still be indexing the old revision. The card is validated against the
   * ONP-2 schema and its signature verified against the node's JWKS (OnpClient.resolveCard).
   * Returns null when the node no longer lists the offering.
   */
  async resolveCardOffering(
    offering: Pick<OnpOffering, 'endpointBase' | 'nodeId' | 'offeringId'>,
  ): Promise<{ cardRevision: string; pricing: OnpPricing } | null> {
    const origin = new URL(offering.endpointBase).origin;
    let card: any;
    try {
      ({ card } = await withTimeout(this.client.resolveCard(origin), `ONP card fetch from ${origin}`));
    } catch (err: any) {
      throw new Error(`ONP card from ${origin} could not be verified: ${err?.message ?? err}`);
    }
    if (card.node?.id !== offering.nodeId) {
      throw new Error(`ONP card at ${origin} is for ${card.node?.id}, not ${offering.nodeId}`);
    }
    const fresh = (card.offerings ?? []).find((o: any) => o.offering_id === offering.offeringId);
    if (!fresh || !card.revision) return null;
    return { cardRevision: String(card.revision), pricing: normalizePricing(fresh.pricing) };
  }
}
