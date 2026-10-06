/// <reference path="./opennodes.d.ts" />
// The ONP advisor (ONP-3 §5b) behind Surge's "Auto" model: routing features are extracted and
// ranked on this device with @opennodes/core — the prompt never leaves it. The candidate pool is
// the registry's admitted nodes (community tier and up): they serve without an API key, which
// imported catalog listings do not.
// Node-only (@opennodes/core uses node:crypto/fs): keep it behind the onp/ai subpaths.
import { extractFeatures, recommend, type OnpFeatures } from '@opennodes/core';
import type { OnpOffering } from './onp-offerings.js';
import type { OnpSpendPolicy } from './onp-policy.js';

/** Model id of the advisor-routed entry in the model list. */
export const ONP_AUTO_MODEL = 'onp:auto';

export interface OnpAdvice {
  features: OnpFeatures;          // what the router saw — counts and classes, never the text
  considered: number;
  eligible: number;
  /** Ranked candidates, best first. */
  picks: Array<{ key: string; score: number; reasons: string[] }>;
}

// The advisor ranks registry records; give it the client's current pin and price, since a card
// re-resolved after a 409 outranks the registry listing.
function toRecord(o: OnpOffering): Record<string, unknown> {
  return {
    ...o.raw,
    tier: o.tier,
    card_revision: o.cardRevision,
    pricing: { currency: o.pricing.currency, input_per_mtok: o.pricing.inputPerMtok, output_per_mtok: o.pricing.outputPerMtok, schemes: o.pricing.schemes },
  };
}

/**
 * Rank `pool` for the latest user turn in `messages` (earlier turns and the system prompt count
 * toward the input size), within the spend policy's tier and price cap. The caller still applies
 * the full policy — per-request ceiling and daily budget — to each pick before invoking it.
 */
export function adviseOnp(
  pool: OnpOffering[],
  messages: Array<{ role: string; content?: unknown }>,
  policy: OnpSpendPolicy,
  limit = 5,
): OnpAdvice {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const task = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const features = extractFeatures(task, { messages: messages.filter((m) => m !== lastUser) });
  const advice = recommend(pool.map(toRecord), features, {
    min_tier: policy.minTier,
    ...(policy.maxPricePerMtok != null ? { max_input_per_mtok: policy.maxPricePerMtok } : {}),
    limit,
  });
  return {
    features,
    considered: advice.considered,
    eligible: advice.eligible,
    picks: advice.recommendations.map((r) => ({ key: r.offering, score: r.score, reasons: r.reasons })),
  };
}
