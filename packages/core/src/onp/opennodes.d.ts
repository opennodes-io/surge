// Ambient types for the published OpenNodes packages, which ship plain ESM JavaScript without
// .d.ts. Only the surface Surge uses; shapes follow @opennodes/core 0.1.1 and @opennodes/cli 0.1.2.
// Both packages are Node-only (node:crypto/fs/http): import them from the onp/ai subpaths only.

declare module '@opennodes/core' {
  /** Routing features extracted from a task — never the text itself (ONP-3 §5b). */
  export interface OnpFeatures {
    modality: string;
    task_class: string;
    language: string;
    est_input_tokens: number;
    est_output_tokens: number;
    needs: {
      tools: boolean;
      tool_categories: string[];
      json: boolean;
      vision: boolean;
      long_context: boolean;
      reasoning: 'low' | 'medium' | 'high';
    };
    latency: 'interactive' | 'batch';
    privacy: 'normal' | 'sensitive';
  }

  export interface OnpRecommendation {
    offering: string;                    // nodeId/offeringId
    model?: string;
    node_id: string;
    tier: string;
    card_revision: string;
    endpoint: string | null;
    model_id: string | null;
    score: number;
    components: Record<string, number>;  // quality, price, trust, perf
    quality_basis: string;
    estimate: { currency: string; min: number; max: number };
    reasons: string[];
  }

  export interface OnpAdvice {
    features: OnpFeatures;
    weights: Record<string, number>;
    considered: number;
    eligible: number;
    rejected: Record<string, number>;
    recommendations: OnpRecommendation[];
  }

  export interface OnpAdvisorPolicy {
    min_tier?: string;
    max_input_per_mtok?: number;
    max_total_usd?: number;
    region?: string;
    prefer_local?: boolean;
    preset?: 'cheap' | 'fast' | 'quality' | 'private' | null;
    limit?: number;
  }

  export function extractFeatures(
    task: string,
    opts?: { messages?: Array<{ content?: unknown }>; attachments?: unknown[]; est_output_tokens?: number | null },
  ): OnpFeatures;

  /** Rank registry offerings (snake_case records as /v0/offerings returns them) for the features. */
  export function recommend(offerings: unknown[], features: OnpFeatures, policy?: OnpAdvisorPolicy): OnpAdvice;
}

declare module '@opennodes/cli' {
  export class OnpClient {
    constructor(opts: { registry: string; policy?: Record<string, unknown> });
    /** GET /v0/offerings — raw registry records. */
    search(params?: Record<string, string>): Promise<any[]>;
    /** POST /v0/estimate. */
    estimate(steps: unknown[]): Promise<any>;
    /** Fetch `{origin}/.well-known/open-node.json`, validate it against the ONP-2 schema and verify its signature; throws otherwise. */
    resolveCard(origin: string): Promise<{ card: any; jwks: any }>;
  }
}
