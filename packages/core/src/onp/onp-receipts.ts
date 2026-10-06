// ONP-5 §5 usage receipts: verify the node-signed JWS and check amount = usage × pinned price.
// Ed25519 via WebCrypto, so this runs unchanged in Electron, the mobile shell and browsers
// (@opennodes/core's verifier is Node-only).
import { ONP_FETCH_TIMEOUT_MS, type OnpOffering, type OnpPricing } from './onp-client.js';

export interface OnpReceipt {
  receipt_id: string;
  node_id: string;
  offering_id: string;
  card_revision: string;
  request_hash?: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
  amount: { currency: string; value: number };
  scheme?: string;
  issued_at?: string;
}

/**
 * verified — signature and amount check out; missing — the node sent no ONP-Receipt;
 * unverified — the receipt or the node key could not be fetched; invalid — it was fetched and fails.
 */
export type OnpReceiptStatus = 'verified' | 'missing' | 'unverified' | 'invalid';

export interface OnpReceiptCheck {
  status: OnpReceiptStatus;
  reason?: string;
  receipt?: OnpReceipt;
}

type PinnedOffering = Pick<OnpOffering, 'endpointBase' | 'nodeId' | 'offeringId' | 'cardRevision' | 'pricing'>;

const JWKS_TTL_MS = 10 * 60_000;
// Amounts are rounded to 6 places by the node; allow one unit of difference so rounding-mode
// differences between implementations (half-up vs. banker's) never read as inflation.
const AMOUNT_TOLERANCE = 1.5e-6;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Cost in the offering's currency for given token counts (ONP-5 receipt math). */
export function costForUsage(pricing: OnpPricing, promptTokens: number, completionTokens: number): number {
  return round6((pricing.inputPerMtok * promptTokens) / 1_000_000 + (pricing.outputPerMtok * completionTokens) / 1_000_000);
}

class Unverifiable extends Error {}

function b64urlBytes(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const bytes = new Uint8Array(bin.length); // ArrayBuffer-backed, as WebCrypto's BufferSource wants
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const b64urlJson = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

const jwksCache = new Map<string, { keys: any[]; at: number }>();

async function nodeKey(origin: string, kid: string | undefined): Promise<CryptoKey> {
  let entry = jwksCache.get(origin);
  const pick = () => entry?.keys.find((k) => !kid || k.kid === kid);
  if (!entry || Date.now() - entry.at > JWKS_TTL_MS || !pick()) {
    let res: Response;
    try {
      res = await fetch(`${origin}/.well-known/jwks.json`, { signal: AbortSignal.timeout(ONP_FETCH_TIMEOUT_MS) });
    } catch (err: any) {
      throw new Unverifiable(`node key fetch failed: ${err?.message ?? err}`);
    }
    if (!res.ok) throw new Unverifiable(`node key fetch failed: ${res.status}`);
    entry = { keys: ((await res.json()) as any).keys ?? [], at: Date.now() };
    jwksCache.set(origin, entry);
  }
  const jwk = pick();
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`no Ed25519 key${kid ? ` "${kid}"` : ''} in the node's JWKS`);
  }
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
}

/** Streaming responses carry the receipt by URL; the node materializes it as the stream ends. */
async function fetchReceipt(url: string, origin: string): Promise<string> {
  if (new URL(url).origin !== origin) throw new Error(`receipt URL is not on the node's origin (${origin})`);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(ONP_FETCH_TIMEOUT_MS) });
    } catch (err: any) {
      throw new Unverifiable(`receipt fetch failed: ${err?.message ?? err}`);
    }
    if (res.ok) return (await res.text()).trim();
    if (res.status !== 404 || attempt >= 3) throw new Unverifiable(`receipt fetch failed: ${res.status}`);
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
}

function checkReceipt(r: OnpReceipt, pinned: PinnedOffering): string | null {
  if (r.node_id !== pinned.nodeId || r.offering_id !== pinned.offeringId) {
    return `receipt is for ${r.node_id}/${r.offering_id}, not ${pinned.nodeId}/${pinned.offeringId}`;
  }
  if (r.card_revision !== pinned.cardRevision) return `receipt revision ${r.card_revision} is not the pinned ${pinned.cardRevision}`;
  if (!r.usage || !r.amount) return 'receipt has no usage or amount';
  if (r.amount.currency !== pinned.pricing.currency) return `receipt is in ${r.amount.currency}, the pinned price in ${pinned.pricing.currency}`;
  const expected = costForUsage(pinned.pricing, r.usage.prompt_tokens, r.usage.completion_tokens);
  if (Math.abs(r.amount.value - expected) > AMOUNT_TOLERANCE) {
    return `amount ${r.amount.value} is not usage × pinned price (${expected})`;
  }
  return null;
}

/** Verify an `ONP-Receipt` header value (inline JWS or URL) against the offering the call was pinned to. */
export async function verifyOnpReceipt(ref: string | null, pinned: PinnedOffering): Promise<OnpReceiptCheck> {
  if (!ref) return { status: 'missing' };
  const origin = new URL(pinned.endpointBase).origin;
  try {
    const jws = /^https?:\/\//.test(ref) ? await fetchReceipt(ref, origin) : ref.trim();
    const [h, p, s] = jws.split('.');
    if (!h || !p || !s) throw new Error('receipt is not a compact JWS');
    const header = b64urlJson(h);
    if (header.alg !== 'EdDSA') throw new Error(`unsupported receipt alg ${header.alg}`);
    const key = await nodeKey(origin, header.kid);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new Error("signature does not verify against the node's key");
    const receipt = b64urlJson(p) as OnpReceipt;
    const problem = checkReceipt(receipt, pinned);
    return problem ? { status: 'invalid', reason: problem, receipt } : { status: 'verified', receipt };
  } catch (err: any) {
    return { status: err instanceof Unverifiable ? 'unverified' : 'invalid', reason: err?.message ?? String(err) };
  }
}
