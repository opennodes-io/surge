// ONP-5 §3 client spend policy, enforced before every invocation (a 409 retry included):
// per-request ceiling, per-day budget, price cap, allowed schemes, minimum trust tier.
import { formatOnpPrice, type OnpOffering, type OnpTier } from './onp-client.js';
import { costForUsage } from './onp-receipts.js';

export interface OnpSpendPolicy {
  /** Ceiling for one request: estimated input + `max_tokens` output at the pinned price (USD). */
  maxRequestUsd: number;
  /** Budget for one UTC day of ONP calls (USD). */
  dailyBudgetUsd: number;
  /** Cap on both the input and the output price per MTok (USD); null = no cap. */
  maxPricePerMtok: number | null;
  minTier: OnpTier;
  /** Payment schemes the user accepts (ONP-5 §2). */
  schemes: string[];
}

export const ONP_SCHEMES = ['free', 'prepaid', 'x402'];

/** Spending off: free offerings run; anything paid is blocked until the user sets a budget. */
export const DEFAULT_ONP_POLICY: OnpSpendPolicy = {
  maxRequestUsd: 0,
  dailyBudgetUsd: 0,
  maxPricePerMtok: null,
  minTier: 'unverified',
  schemes: ONP_SCHEMES,
};

// Registry tiers in trust order; local/lan are the user's own machines. disputed and suspended
// rank below every selectable minimum, so they are always blocked. Unknown tiers count as unverified.
const TIER_RANK: Partial<Record<OnpTier, number>> = {
  suspended: -2, disputed: -1, unverified: 0, community: 1, verified: 2, attested: 3, lan: 4, local: 4,
};
const rank = (t: OnpTier) => TIER_RANK[t] ?? 0;

const nonNegative = (v: any, fallback: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

/** Merge a stored (possibly partial or hand-edited) policy over the defaults. */
export function normalizeOnpPolicy(raw: any): OnpSpendPolicy {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    maxRequestUsd: nonNegative(p.maxRequestUsd, DEFAULT_ONP_POLICY.maxRequestUsd),
    dailyBudgetUsd: nonNegative(p.dailyBudgetUsd, DEFAULT_ONP_POLICY.dailyBudgetUsd),
    maxPricePerMtok: p.maxPricePerMtok == null || p.maxPricePerMtok === '' ? null : nonNegative(p.maxPricePerMtok, 0),
    minTier: p.minTier in TIER_RANK ? p.minTier : DEFAULT_ONP_POLICY.minTier,
    schemes: Array.isArray(p.schemes) ? p.schemes.map(String) : DEFAULT_ONP_POLICY.schemes,
  };
}

export interface OnpRequestBounds {
  estInputTokens: number;
  maxTokens: number;
  spentTodayUsd: number;
}

/** Most a request can cost at the pinned price (ONP-5: `max_tokens` × pinned price, plus input). */
export function onpRequestCeiling(offering: Pick<OnpOffering, 'pricing'>, bounds: Pick<OnpRequestBounds, 'estInputTokens' | 'maxTokens'>): number {
  return costForUsage(offering.pricing, bounds.estInputTokens, bounds.maxTokens);
}

/** Why the policy blocks this invocation, or null when it may proceed. */
export function checkOnpPolicy(
  offering: Pick<OnpOffering, 'tier' | 'pricing'>,
  policy: OnpSpendPolicy,
  bounds: OnpRequestBounds,
): string | null {
  const p = offering.pricing;
  if (rank(offering.tier) < rank(policy.minTier)) return `tier ${offering.tier} is below your minimum (${policy.minTier})`;
  if (policy.maxPricePerMtok != null && (p.inputPerMtok > policy.maxPricePerMtok || p.outputPerMtok > policy.maxPricePerMtok)) {
    return `price ${formatOnpPrice(p)} is above your cap of $${policy.maxPricePerMtok} per MTok`;
  }
  if (p.schemes.length && !p.schemes.some((s) => policy.schemes.includes(s))) {
    return `payment scheme ${p.schemes.join(' / ')} is not allowed`;
  }
  const ceiling = onpRequestCeiling(offering, bounds);
  if (ceiling === 0) return null; // free calls never touch the budgets
  if (p.currency !== 'USD') return `it is priced in ${p.currency} and your budgets are in USD`;
  if (ceiling > policy.maxRequestUsd) return `this request could cost up to $${ceiling} (your limit is $${policy.maxRequestUsd} per request)`;
  const dayTotal = Math.round((bounds.spentTodayUsd + ceiling) * 1e6) / 1e6;
  if (dayTotal > policy.dailyBudgetUsd) {
    return `it could take today's spend to $${dayTotal} (your daily budget is $${policy.dailyBudgetUsd})`;
  }
  return null;
}
