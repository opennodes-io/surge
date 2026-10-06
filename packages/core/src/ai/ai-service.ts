import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import type { SettingsPort, SecretStorePort } from '../ports/index.js';
import type { ToolDefinition } from '../mcp/mcp-manager.js';
import {
  OnpRegistryClient, ONP_DEFAULT_REGISTRY, ONP_AUTO_MODEL, adviseOnp, onpPriceRaised, formatOnpPrice, verifyOnpReceipt,
  checkOnpPolicy, normalizeOnpPolicy, onpRequestCeiling, ONP_FETCH_TIMEOUT_MS,
  type OnpOffering, type OnpTier, type OnpReceiptStatus, type OnpSpendPolicy,
} from '../onp/index.js';

export type ModelLevel = 'quick' | 'smart' | 'best';

export interface AiModel {
  id: string;
  name: string;
  provider: 'gemini' | 'groq' | 'ollama' | 'claude' | 'mistral' | 'vllm' | 'onp' | 'private';
  tier: 'free' | 'pro' | 'enterprise';
  description: string;
  supportsToolCalling: boolean;
  level: ModelLevel;       // Quick / Smart / Best classification
  costEstimate: string;    // e.g. "Free", "~$0.01/msg"
}

/** One settled ONP call — what the chat shows under a reply, and what spend tracking counted. */
export interface OnpCallRecord {
  at: number;                    // when the call settled (ms since epoch)
  offering: string;              // nodeId/offeringId
  modelName: string;
  nodeId: string;
  tier: OnpTier;
  registryTtftMsP50?: number;    // registry-measured (probes), not this call
  durationMs: number;            // this call, first request → end of response, measured by Surge
  price: string;                 // the pinned price, formatted
  cardRevision: string;          // the revision the call was pinned to (after any re-pin)
  receipt: OnpReceiptStatus;
  reason?: string;               // why the receipt is unverified/invalid
  receiptId?: string;
  usage?: { promptTokens: number; completionTokens: number };
  amount?: { currency: string; value: number };
  countedUsd: number;            // what the daily budget counted: the verified amount, else the request ceiling
  /** Set when the Auto model routed the call: why this node, and which picks failed first. */
  advisor?: { taskClass: string; score: number; reasons: string[]; considered: number; eligible: number; skipped: string[] };
}

/** What an ONP call was pinned to, kept until its receipt is settled. */
interface OnpCallContext {
  offering: OnpOffering;         // as pinned for the request that succeeded
  receiptRef: string | null;     // ONP-Receipt header: inline JWS or URL
  ceiling: number;               // most the call could cost; counted when no verified receipt says otherwise
  startedAt: number;
  advisor?: OnpCallRecord['advisor'];
}

// Nominal request for marking listed offerings the policy would block (the real check, per
// request, uses the actual prompt size).
const NOMINAL_INPUT_TOKENS = 1000;

// Per-host API keys for OpenNodes endpoints live in the secret store as `onp.key.<hostname>`:
// a key is only ever sent to the host it was saved for (the gateway's BYOK model).
const ONP_KEY_PREFIX = 'onp.key.';
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const hostOf = (o: Pick<OnpOffering, 'endpointBase'>) => new URL(o.endpointBase).hostname;

/** Private mode's advisor model: routes only to local and LAN models (served by @opennodes/ollama-router). */
export const PRIVATE_AUTO_MODEL = 'private:auto-private';

interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall?: (toolCalls: PendingToolCall[]) => void;
  onOnpCall?: (call: OnpCallRecord) => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Conservative prompt-token estimate for the spend ceiling (~3 chars per token, tools included). */
function estimateInputTokens(params: any): number {
  return Math.ceil((JSON.stringify(params.messages ?? []).length + (params.tools ? JSON.stringify(params.tools).length : 0)) / 3);
}

// Represents a tool call the AI wants to make
export interface PendingToolCall {
  id: string;
  functionName: string;
  arguments: Record<string, any>;
}

// Message format supporting tool results
export interface ChatMessageWithTools {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

const ALL_MODELS: AiModel[] = [
  // ⚡ Quick level — free, fast responses
  { id: 'gemini-flash-lite', name: 'Gemini 2.5 Flash-Lite', provider: 'gemini', tier: 'free', description: 'Fast & free, 1000 req/day', supportsToolCalling: true, level: 'quick', costEstimate: 'Free' },
  { id: 'groq-llama', name: 'Llama 3.3 70B (Groq)', provider: 'groq', tier: 'free', description: 'Ultra-fast inference, free', supportsToolCalling: true, level: 'quick', costEstimate: 'Free' },
  { id: 'ollama-local', name: 'Ollama Local', provider: 'ollama', tier: 'free', description: 'Private, unlimited, local', supportsToolCalling: true, level: 'quick', costEstimate: 'Free' },
  // 🧠 Smart level — great for most tasks
  { id: 'gemini-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', tier: 'pro', description: 'Most capable Gemini model', supportsToolCalling: true, level: 'smart', costEstimate: '~$0.01/msg' },
  { id: 'claude-sonnet', name: 'Claude Sonnet', provider: 'claude', tier: 'pro', description: 'Balanced power & speed', supportsToolCalling: true, level: 'smart', costEstimate: '~$0.01/msg' },
  { id: 'mistral-large', name: 'Mistral Large', provider: 'mistral', tier: 'pro', description: 'Multilingual powerhouse', supportsToolCalling: true, level: 'smart', costEstimate: '~$0.01/msg' },
  { id: 'vllm-custom', name: 'vLLM / Local Network', provider: 'vllm', tier: 'free', description: 'Your own LAN or self-hosted model', supportsToolCalling: true, level: 'quick', costEstimate: 'Free' },
  // 💎 Best level — maximum quality
  { id: 'claude-opus', name: 'Claude Opus', provider: 'claude', tier: 'enterprise', description: 'Most capable Claude model', supportsToolCalling: true, level: 'best', costEstimate: '~$0.05/msg' },
];

export class AiService {
  private settings: SettingsPort;
  private geminiClient: GoogleGenerativeAI | null = null;
  private groqClient: OpenAI | null = null;
  private ollamaClient: OpenAI | null = null;
  private claudeClient: OpenAI | null = null;
  private mistralClient: OpenAI | null = null;
  private vllmClient: OpenAI | null = null;

  // Private mode: an embedded @opennodes/ollama-router (started by the shell) serving local + LAN models only
  private privateRouter: string | null = null;
  private privateClient: OpenAI | null = null;

  // OpenNodes (ONP) registry: dynamic model discovery with trust tiers + measured perf
  private onpRegistry: OnpRegistryClient | null = null;
  private onpOfferings: Map<string, OnpOffering> = new Map();
  private onpModels: AiModel[] = [];
  private onpClients: Map<string, OpenAI> = new Map(); // by endpoint base; pins go per request
  private onpLoadedAt = 0;
  private onpCalls: OnpCallRecord[] = [];              // this session's settled calls
  private onpCallListeners = new Set<(call: OnpCallRecord) => void>();
  private onpPool: string[] = [];                      // offerings the Auto model routes over
  private secrets: SecretStorePort | null;

  constructor(settings: SettingsPort, secrets: SecretStorePort | null = null) {
    this.settings = settings;
    this.secrets = secrets;
    this.initClients();
  }

  refreshConfig(): void {
    this.initClients();
  }

  private initClients(): void {
    // Gemini (free — API key optional for Flash-Lite via AI Studio)
    const geminiKey = this.settings.get('ai.geminiApiKey');
    if (geminiKey) {
      this.geminiClient = new GoogleGenerativeAI(geminiKey);
    }

    // Groq (free — needs free API key from console.groq.com)
    const groqKey = this.settings.get('ai.groqApiKey');
    if (groqKey) {
      this.groqClient = new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
    }

    // Ollama (local — no key needed)
    const ollamaHost = this.settings.get('ai.ollamaHost') || 'http://localhost:11434';
    this.ollamaClient = new OpenAI({
      apiKey: 'ollama', // Ollama doesn't need a real key
      baseURL: `${ollamaHost}/v1`,
    });

    // Claude (pro)
    const claudeKey = this.settings.get('ai.claudeApiKey');
    if (claudeKey) {
      this.claudeClient = new OpenAI({
        apiKey: claudeKey,
        baseURL: 'https://api.anthropic.com/v1',
      });
    }

    // Mistral (pro)
    const mistralKey = this.settings.get('ai.mistralApiKey');
    if (mistralKey) {
      this.mistralClient = new OpenAI({
        apiKey: mistralKey,
        baseURL: 'https://api.mistral.ai/v1',
      });
    }

    // vLLM / OpenAI-compatible (local network or self-hosted)
    const vllmEndpoint = this.settings.get('ai.vllmEndpoint');
    if (vllmEndpoint) {
      let baseURL = vllmEndpoint.trim().replace(/\/+$/, '');
      if (!baseURL.endsWith('/v1')) baseURL += '/v1';
      const vllmApiKey = this.settings.get('ai.vllmApiKey');
      this.vllmClient = new OpenAI({
        apiKey: vllmApiKey || 'not-required',
        baseURL,
      });
    }

    // OpenNodes registry (model discovery — no key needed for browsing)
    const onpUrl = this.settings.get('ai.onpRegistryUrl') || ONP_DEFAULT_REGISTRY;
    this.onpRegistry = new OnpRegistryClient(onpUrl);
    this.onpOfferings.clear();
    this.onpClients.clear();
    this.onpModels = [];
    this.onpPool = [];
    this.onpLoadedAt = 0;
  }

  /** Refresh the ONP model list from the registry (tolerates the registry being offline). */
  async refreshOnpModels(): Promise<void> {
    if (!this.onpRegistry) return;
    try {
      const [listed, admitted, keyed] = await Promise.all([
        this.onpRegistry.searchOfferings({ modality: 'text', sort: 'rank', limit: 40 }),
        // The Auto model's pool: admitted nodes serve without an API key; imported listings don't,
        // so they join the pool only for hosts the user has saved a key for.
        this.onpRegistry.searchOfferings({ modality: 'text', tier: 'community', sort: 'rank', limit: 100 }).catch(() => []),
        this.getOnpKeyHosts(),
      ]);
      // A pin re-resolved from the node's card (createCompletion) outranks a registry that is still
      // indexing an older revision; revisions are strictly increasing ISO-8601 timestamps (ONP-2).
      const keepPin = (o: OnpOffering): OnpOffering => {
        const known = this.onpOfferings.get(o.key);
        return known && Date.parse(known.cardRevision) > Date.parse(o.cardRevision)
          ? { ...o, cardRevision: known.cardRevision, pricing: known.pricing } : o;
      };
      const offerings = listed.map(keepPin);
      const admittedPool = admitted.map(keepPin);
      const keyedPool = offerings.filter((o) => keyed.includes(hostOf(o)) && !admittedPool.some((a) => a.key === o.key));
      const pool = [...admittedPool, ...keyedPool];
      this.onpOfferings = new Map([...pool, ...offerings].map((o) => [o.key, o]));
      this.onpPool = pool.map((o) => o.key);
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const poolText = keyedPool.length
        ? `${plural(admittedPool.length, 'admitted node')} + ${plural(keyedPool.length, 'offering')} you have keys for`
        : plural(admittedPool.length, 'admitted node');
      const auto: AiModel[] = pool.length ? [{
        id: ONP_AUTO_MODEL,
        name: 'Auto (OpenNodes advisor)',
        provider: 'onp',
        tier: 'free',
        description: `Picks one of ${poolText} per prompt · ranked on this device, the prompt never leaves it`,
        supportsToolCalling: pool.some((o) => o.supports.includes('tool_calls')),
        level: 'smart',
        costEstimate: 'By policy',
      }] : [];
      this.onpModels = [...auto, ...offerings.map((o) => {
        const bits = [o.tier.toUpperCase(), o.nodeId];
        if (o.measured.ttftMsP50 != null) bits.push(`${o.measured.ttftMsP50}ms measured`);
        if (o.institutional) bits.push('institutional');
        if (o.local) bits.push(`local: ${o.local.run}`);
        return {
          id: `onp:${o.key}`,
          name: o.modelName,
          provider: 'onp' as const,
          tier: 'free' as const,           // visibility gating stays with Surge tiers
          description: bits.join(' · '),
          supportsToolCalling: o.supports.includes('tool_calls'),
          level: (o.tier === 'verified' || o.tier === 'attested' ? 'smart' : 'quick') as ModelLevel,
          costEstimate: formatOnpPrice(o.pricing),
        };
      })];
      this.onpLoadedAt = Date.now();
    } catch {
      // registry unreachable — keep whatever we had; the static model list still works
    }
  }

  /** Static providers plus live ONP registry models (refreshed at most once a minute). */
  async listModels(): Promise<AiModel[]> {
    // Private mode lists only models on the user's own machines and never contacts the registry.
    if (this.isPrivateMode()) return this.listPrivateModels();
    if (Date.now() - this.onpLoadedAt > 60_000) await this.refreshOnpModels();
    // Marked live, so a policy change shows on the next listing without a registry refresh.
    const policy = this.getOnpPolicy();
    const bounds = { estInputTokens: NOMINAL_INPUT_TOKENS, maxTokens: 4096, spentTodayUsd: this.getOnpSpentToday() };
    const keyed = await this.getOnpKeyHosts();
    const onp = this.onpModels.map((m) => {
      const offering = this.onpOfferings.get(m.id.slice(4));
      if (!offering) return m;
      const notes = [keyed.includes(hostOf(offering)) ? 'your key' : '', checkOnpPolicy(offering, policy, bounds) ? 'blocked by your spend policy' : '']
        .filter(Boolean);
      return notes.length ? { ...m, description: `${m.description} · ${notes.join(' · ')}` } : m;
    });
    return [...this.getAvailableModels(), ...onp];
  }

  /** Private mode: model calls go only to the user's own machines (local Ollama and LAN peers). */
  isPrivateMode(): boolean {
    return this.settings.get('private.enabled') === true;
  }

  /** Point private mode at a running @opennodes/ollama-router (the shell starts it with no registry), or detach. */
  setPrivateRouter(origin: string | null): void {
    this.privateRouter = origin;
    this.privateClient = origin ? new OpenAI({ apiKey: 'not-required', baseURL: `${origin}/v1`, maxRetries: 0 }) : null;
  }

  /** The router's local and LAN models, led by its auto-private advisor model. */
  async listPrivateModels(): Promise<AiModel[]> {
    if (!this.privateRouter) return [];
    try {
      const res = await fetch(`${this.privateRouter}/router/catalog`, { signal: AbortSignal.timeout(ONP_FETCH_TIMEOUT_MS) });
      const catalog: any = await res.json();
      const own: Array<{ name: string; tier: string; origin: string }> = (catalog.models ?? []).filter((m: any) => m.tier === 'local' || m.tier === 'lan');
      return [
        {
          id: PRIVATE_AUTO_MODEL, name: 'Auto (private)', provider: 'private', tier: 'free',
          description: `Picks one of ${own.length} model${own.length === 1 ? '' : 's'} on your machines per prompt · nothing leaves your network`,
          supportsToolCalling: true, level: 'smart', costEstimate: 'Free',
        },
        ...own.map((m): AiModel => ({
          id: `private:${m.name}`, name: m.name, provider: 'private', tier: 'free',
          description: `${m.tier.toUpperCase()} · ${m.origin}`, supportsToolCalling: true, level: 'quick', costEstimate: 'Free',
        })),
      ];
    } catch {
      return [];
    }
  }

  private assertModelAllowed(modelKey: string): void {
    if (this.isPrivateMode() && !modelKey.startsWith('private:')) {
      throw new Error('Private mode is on, so only models on your own machines can answer. Pick one (or Auto (private)), or turn private mode off.');
    }
    if (modelKey.startsWith('private:') && !this.privateClient) {
      throw new Error('Private mode is not running. Turn it on to use the models on your own machines.');
    }
  }

  /** Hostnames that have a saved OpenNodes API key (names only — keys never leave the store). */
  async getOnpKeyHosts(): Promise<string[]> {
    const names = (await this.secrets?.listSecrets?.()) ?? [];
    return names.filter((n) => n.startsWith(ONP_KEY_PREFIX)).map((n) => n.slice(ONP_KEY_PREFIX.length)).sort();
  }

  /** Hosts of listed offerings that need the user's key (imported catalogs), with how many offerings each serves. */
  getOnpKeyHostSuggestions(): Array<{ host: string; offerings: number }> {
    const counts = new Map<string, number>();
    for (const o of this.onpOfferings.values()) {
      if (o.source === 'import') counts.set(hostOf(o), (counts.get(hostOf(o)) ?? 0) + 1);
    }
    return [...counts].map(([host, offerings]) => ({ host, offerings })).sort((a, b) => b.offerings - a.offerings);
  }

  /** Save the API key for one host; it is sent only to endpoints on exactly that hostname. */
  async setOnpKey(host: string, key: string): Promise<void> {
    if (!this.secrets) throw new Error('No secret store is available to keep API keys.');
    const h = host.trim().toLowerCase();
    if (!HOSTNAME.test(h)) throw new Error(`"${host}" is not a hostname.`);
    if (!key.trim()) throw new Error('The API key is empty.');
    await this.secrets.setSecret(ONP_KEY_PREFIX + h, key.trim());
    this.forgetOnpHost(h);
  }

  async deleteOnpKey(host: string): Promise<void> {
    const h = host.trim().toLowerCase();
    await this.secrets?.deleteSecret?.(ONP_KEY_PREFIX + h);
    this.forgetOnpHost(h);
  }

  // Clients carry the key they were built with; a key change rebuilds them and re-forms the Auto pool.
  private forgetOnpHost(host: string): void {
    for (const base of [...this.onpClients.keys()]) {
      if (new URL(base).hostname === host) this.onpClients.delete(base);
    }
    this.onpLoadedAt = 0;
  }

  /** Pre-price a prompt against an ONP model (enforceable registry estimate). */
  async estimateOnp(modelKey: string, estInputTokens = 1000, estOutputTokens = 300) {
    if (!modelKey.startsWith('onp:') || modelKey === ONP_AUTO_MODEL || !this.onpRegistry) return null;
    return this.onpRegistry.estimate([
      { offering: modelKey.slice(4), est_input_tokens: estInputTokens, est_output_tokens: estOutputTokens },
    ]);
  }

  private getOnpOffering(modelKey: string): OnpOffering {
    const key = modelKey.slice(4); // strip "onp:"
    const offering = this.onpOfferings.get(key);
    if (!offering) {
      throw new Error(`ONP offering ${key} is not in the current model list — refresh models first.`);
    }
    return offering;
  }

  private async getOnpClient(offering: OnpOffering): Promise<OpenAI> {
    let client = this.onpClients.get(offering.endpointBase);
    if (!client) {
      const key = await this.secrets?.getSecret(ONP_KEY_PREFIX + hostOf(offering));
      client = new OpenAI({
        apiKey: key || 'not-required',
        baseURL: offering.endpointBase,
        // The SDK resends 409s unchanged; ONP's 409 needs a re-resolved pin instead (invokeOnp).
        maxRetries: 0,
      });
      this.onpClients.set(offering.endpointBase, client);
    }
    return client;
  }

  getOnpPolicy(): OnpSpendPolicy {
    return normalizeOnpPolicy(this.settings.get('onp.policy'));
  }

  /** Today's (UTC) ONP spend in USD, persisted through the settings port. */
  getOnpSpentToday(): number {
    const spend = this.settings.get('onp.spend');
    return spend?.day === utcDay() ? Number(spend.usd) || 0 : 0;
  }

  /** This session's settled ONP calls, oldest first. */
  getOnpCalls(): OnpCallRecord[] {
    return [...this.onpCalls];
  }

  private addOnpSpend(usd: number): void {
    if (usd > 0) this.settings.set('onp.spend', { day: utcDay(), usd: round6(this.getOnpSpentToday() + usd) });
  }

  /** ONP-5 §3: check the spend policy before an invocation; returns the request's cost ceiling. */
  private enforceOnpPolicy(offering: OnpOffering, params: any, preface = ''): number {
    const bounds = { estInputTokens: estimateInputTokens(params), maxTokens: params.max_tokens ?? 4096, spentTodayUsd: this.getOnpSpentToday() };
    const blocked = checkOnpPolicy(offering, this.getOnpPolicy(), bounds);
    if (blocked) throw new Error(`${preface}Blocked by your OpenNodes spend policy: ${blocked}. You can change it in Settings.`);
    return onpRequestCeiling(offering, bounds);
  }

  /** Verify the call's receipt, count it against today's budget, and describe the call for the UI. */
  private async settleOnp(ctx: OnpCallContext): Promise<OnpCallRecord> {
    const { offering } = ctx;
    const check = await verifyOnpReceipt(ctx.receiptRef, offering);
    const r = check.receipt;
    // Only a verified receipt says what the call cost; otherwise count the most the policy allowed.
    const countedUsd = check.status === 'verified' && r ? r.amount.value : ctx.ceiling;
    this.addOnpSpend(countedUsd);
    const record: OnpCallRecord = {
      at: Date.now(),
      offering: offering.key,
      modelName: offering.modelName,
      nodeId: offering.nodeId,
      tier: offering.tier,
      registryTtftMsP50: offering.measured.ttftMsP50,
      durationMs: Date.now() - ctx.startedAt,
      price: formatOnpPrice(offering.pricing),
      cardRevision: offering.cardRevision,
      receipt: check.status,
      reason: check.reason,
      receiptId: r?.receipt_id,
      usage: r?.usage ? { promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens } : undefined,
      amount: r?.amount,
      countedUsd,
      advisor: ctx.advisor,
    };
    this.onpCalls.push(record);
    for (const listener of this.onpCallListeners) {
      try { listener(record); } catch { /* a failing listener (e.g. the ledger) must not fail the call */ }
    }
    return record;
  }

  /** Be told about every settled ONP call (the desktop persists them for the spend dashboard). */
  onOnpCallSettled(listener: (call: OnpCallRecord) => void): () => void {
    this.onpCallListeners.add(listener);
    return () => this.onpCallListeners.delete(listener);
  }

  /** ONP invocation profile: pin what we're calling and the price we saw — read fresh on every request. */
  private onpPinHeaders(offering: OnpOffering): OpenAI.RequestOptions {
    return {
      headers: {
        'onp-offering': offering.key,
        'onp-card-revision': offering.cardRevision,
      },
    };
  }

  /**
   * chat.completions.create for any model. ONP models go through invokeOnp; the Auto model asks
   * the advisor for ranked picks and falls back down the list when a pick is blocked by the
   * policy or fails before its response starts (the lab-style nodes are often offline).
   */
  private async createCompletion(modelKey: string, client: OpenAI | null, params: any): Promise<{ data: any; onp?: OnpCallContext }> {
    if (!modelKey.startsWith('onp:')) return { data: await client!.chat.completions.create(params) };
    if (modelKey !== ONP_AUTO_MODEL) return this.invokeOnp(this.getOnpOffering(modelKey), params);

    const pool = this.onpPool.map((k) => this.onpOfferings.get(k)).filter((o): o is OnpOffering => !!o);
    const advice = adviseOnp(pool, params.messages ?? [], this.getOnpPolicy());
    const skipped: string[] = [];
    for (const pick of advice.picks) {
      const offering = this.onpOfferings.get(pick.key);
      if (!offering) continue;
      const advisor = {
        taskClass: advice.features.task_class, score: pick.score, reasons: pick.reasons,
        considered: advice.considered, eligible: advice.eligible, skipped: [...skipped],
      };
      try {
        return await this.invokeOnp(offering, params, advisor);
      } catch (err: any) {
        skipped.push(`${pick.key}: ${err?.message ?? err}`);
      }
    }
    throw new Error(advice.picks.length
      ? `Auto could not place this request on any admitted node — ${skipped.join('; ')}`
      : `Auto found no admitted node for this request (${advice.eligible} of ${advice.considered} fit the task and your policy).`);
  }

  /**
   * One ONP invocation: the spend policy checked before every request, pinned headers, and
   * ONP-4 409 handling — re-resolve the offering from the node's verified card, re-apply the
   * policy at the new price, and retry once, or surface why not. `offering-mismatch` is surfaced.
   */
  private async invokeOnp(offering: OnpOffering, params: any, advisor?: OnpCallRecord['advisor']): Promise<{ data: any; onp: OnpCallContext }> {
    const client = await this.getOnpClient(offering);
    const startedAt = Date.now();
    const send = async (pinned: OnpOffering, preface?: string) => {
      const ceiling = this.enforceOnpPolicy(pinned, params, preface);
      const body = { ...params, model: pinned.bindingModelId };
      const { data, response } = await client.chat.completions.create(body, this.onpPinHeaders(pinned)).withResponse();
      return { data, onp: { offering: pinned, receiptRef: response.headers.get('onp-receipt'), ceiling, startedAt, advisor } };
    };
    try {
      return await send(offering);
    } catch (err: any) {
      if (err?.status !== 409) throw err;
      // The SDK keeps only `{error: …}` bodies, so the node's problem+json title is lost. The card
      // decides instead: a newer revision means price_changed, the same one offering-mismatch.
      const fresh = await this.onpRegistry!.resolveCardOffering(offering);
      if (!fresh) throw new Error(`${offering.nodeId} no longer offers ${offering.offeringId}. Refresh models.`);
      if (fresh.cardRevision === offering.cardRevision) {
        throw new Error(`${offering.nodeId} no longer serves ${offering.key} at this endpoint. Refresh models.`);
      }
      const repinned: OnpOffering = { ...offering, cardRevision: fresh.cardRevision, pricing: fresh.pricing };
      this.onpOfferings.set(offering.key, repinned);
      const model = this.onpModels.find((m) => m.id === `onp:${offering.key}`);
      if (model) model.costEstimate = formatOnpPrice(fresh.pricing);
      const preface = onpPriceRaised(offering.pricing, fresh.pricing)
        ? `${offering.modelName} on ${offering.nodeId} changed price from ${formatOnpPrice(offering.pricing)} to ${formatOnpPrice(fresh.pricing)}. `
        : '';
      try {
        return await send(repinned, preface);
      } catch (retryErr: any) {
        if (retryErr?.status !== 409) throw retryErr;
        throw new Error(`${offering.nodeId} rejected the re-resolved pin for ${offering.key} (revision ${fresh.cardRevision}).`);
      }
    }
  }

  getAvailableModels(): AiModel[] {
    const tier = this.settings.getTier();
    return ALL_MODELS.filter(m => {
      if (m.tier === 'enterprise') return tier === 'enterprise';
      if (m.tier === 'pro') return tier === 'pro' || tier === 'enterprise';
      return true;
    });
  }

  private getModelId(modelKey: string): string {
    switch (modelKey) {
      case 'gemini-flash-lite': return 'gemini-2.5-flash-lite';
      case 'gemini-pro': return 'gemini-2.5-pro';
      case 'groq-llama': return 'llama-3.3-70b-versatile';
      case 'ollama-local': return 'llama3.2';
      case 'claude-sonnet': return 'claude-sonnet-4-20250514';
      case 'claude-opus': return 'claude-opus-4-20250514';
      case 'mistral-large': return 'mistral-large-latest';
      case 'vllm-custom': return this.settings.get('ai.vllmModel') || 'default';
      default: return modelKey;
    }
  }

  // ONP models resolve their client per offering in invokeOnp.
  private getClientForModel(modelKey: string): { client: OpenAI | null; modelId: string } {
    if (modelKey.startsWith('private:')) return { client: this.privateClient, modelId: modelKey.slice('private:'.length) };
    const modelId = this.getModelId(modelKey);
    switch (modelKey) {
      case 'groq-llama': return { client: this.groqClient, modelId };
      case 'ollama-local': return { client: this.ollamaClient, modelId };
      case 'claude-sonnet':
      case 'claude-opus': return { client: this.claudeClient, modelId };
      case 'mistral-large': return { client: this.mistralClient, modelId };
      case 'vllm-custom': return { client: this.vllmClient, modelId };
      default: return { client: null, modelId };
    }
  }

  async chat(messages: any[], modelKey: string): Promise<any> {
    this.assertModelAllowed(modelKey);
    // Gemini uses its own SDK
    if (modelKey.startsWith('gemini')) {
      return this.chatGemini(messages, modelKey);
    }

    const { client, modelId } = this.getClientForModel(modelKey);
    if (!client && !modelKey.startsWith('onp:')) {
      throw new Error(`No client configured for model: ${modelKey}. Please set the API key in Settings.`);
    }

    const { data: response, onp } = await this.createCompletion(modelKey, client, {
      model: modelId,
      messages: messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: 0.7,
      max_tokens: 4096,
    });

    return {
      content: response.choices[0]?.message?.content || '',
      model: onp ? onp.offering.bindingModelId : modelId,
      ...(onp ? { onp: await this.settleOnp(onp) } : {}),
    };
  }

  // ── Streaming with Tool Calling Support ─────────────────
  async streamChat(
    messages: ChatMessageWithTools[],
    modelKey: string,
    callbacks: StreamCallbacks,
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): Promise<void> {
    try {
      this.assertModelAllowed(modelKey);
      // Inject system prompt if provided
      const augmentedMessages = [...messages];
      if (systemPrompt) {
        // Add/replace system message at the beginning
        const hasSystem = augmentedMessages[0]?.role === 'system';
        if (hasSystem) {
          augmentedMessages[0] = { role: 'system', content: systemPrompt };
        } else {
          augmentedMessages.unshift({ role: 'system', content: systemPrompt });
        }
      }

      // Gemini streaming
      if (modelKey.startsWith('gemini')) {
        return this.streamGemini(augmentedMessages, modelKey, callbacks, tools);
      }

      const { client, modelId } = this.getClientForModel(modelKey);
      if (!client && !modelKey.startsWith('onp:')) {
        throw new Error(`No client configured for model: ${modelKey}. Please set the API key in Settings.`);
      }

      // Build OpenAI request params (ONP sets `model` per offering in invokeOnp)
      const params: any = {
        model: modelId,
        messages: augmentedMessages.map((m) => {
          const msg: any = { role: m.role, content: m.content };
          if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
          if (m.name) msg.name = m.name;
          if (m.tool_calls) msg.tool_calls = m.tool_calls;
          return msg;
        }),
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      };

      // Include tool definitions if available
      if (tools && tools.length > 0) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      // ONP nodes forward the body to their engine: asking for the terminal usage chunk gets
      // real token counts into the receipt instead of the node's approximation (ONP-4 §2).
      if (modelKey.startsWith('onp:')) params.stream_options = { include_usage: true };

      let stream: any;
      let onp: OnpCallContext | undefined;
      let usePromptBasedTools = false;

      try {
        ({ data: stream, onp } = await this.createCompletion(modelKey, client, params));
      } catch (err: any) {
        // For vLLM/local models that don't support native tool calling,
        // fall back to prompt-based tool calling
        const isToolChoiceError = err.message?.includes('tool_choice') || err.message?.includes('tool-call-parser') || err.message?.includes('enable-auto-tool');
        if (params.tools && isToolChoiceError && (modelKey === 'vllm-custom' || modelKey === 'ollama-local')) {
          // Inject tool descriptions into system prompt for prompt-based calling
          const toolDescriptions = (tools || []).map(t =>
            `- ${t.function.name}: ${t.function.description}\n  Parameters: ${JSON.stringify(t.function.parameters?.properties || {})}`
          ).join('\n');

          const toolSystemPrompt = `\nYou have access to these tools:\n${toolDescriptions}\n\nTo call a tool, output EXACTLY this format (no other text around it):\n<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>\n\nYou can call multiple tools by using multiple <tool_call> blocks. After tool results are provided, continue your response.\n`;

          // Update system message with tool instructions
          const sysIdx = params.messages.findIndex((m: any) => m.role === 'system');
          if (sysIdx >= 0) {
            params.messages[sysIdx].content += toolSystemPrompt;
          } else {
            params.messages.unshift({ role: 'system', content: toolSystemPrompt });
          }

          // Also convert any 'tool' role messages to user messages for models that don't support them
          params.messages = params.messages.map((m: any) => {
            if (m.role === 'tool') {
              return { role: 'user', content: `[Tool result for ${m.name}]: ${m.content}` };
            }
            if (m.role === 'assistant' && m.tool_calls) {
              const callsText = m.tool_calls.map((tc: any) =>
                `<tool_call>${JSON.stringify({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') })}</tool_call>`
              ).join('\n');
              return { role: 'assistant', content: callsText || '' };
            }
            return m;
          });

          delete params.tools;
          delete params.tool_choice;
          usePromptBasedTools = true;
          stream = await client!.chat.completions.create(params); // vllm/ollama: client checked above
        } else {
          throw err;
        }
      }

      // Accumulate tool calls from streaming deltas
      const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let fullText = ''; // Accumulate full text for prompt-based tool parsing

      for await (const chunk of stream as any) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        // Text content
        const textDelta = choice.delta?.content;
        if (textDelta) {
          fullText += textDelta;
          // For prompt-based tools, buffer tokens containing <tool_call> to avoid showing raw XML
          if (usePromptBasedTools && fullText.includes('<tool_call>')) {
            // Don't stream tool call XML to the user — will be parsed after stream ends
          } else {
            callbacks.onToken(textDelta);
          }
        }

        // Tool call deltas
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, {
                id: tc.id || `call_${Date.now()}_${idx}`,
                name: tc.function?.name || '',
                args: '',
              });
            }
            const pending = pendingToolCalls.get(idx)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }
      }

      // The stream is read to its end before tool calls are dispatched: leaving early aborts the
      // response before the terminal usage chunk, and an ONP node settles its receipt only then.
      if (onp) callbacks.onOnpCall?.(await this.settleOnp(onp));

      // Dispatch tool calls (finish_reason varies: some providers use 'stop', some omit it)
      if (pendingToolCalls.size > 0) {
        const toolCalls: PendingToolCall[] = [];
        for (const [, tc] of pendingToolCalls) {
          if (!tc.name) continue; // Skip incomplete tool calls
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = JSON.parse(tc.args || '{}');
          } catch {
            parsedArgs = {};
          }
          toolCalls.push({
            id: tc.id,
            functionName: tc.name,
            arguments: parsedArgs,
          });
        }
        if (toolCalls.length > 0) {
          callbacks.onToolCall?.(toolCalls);
          return;
        }
      }

      // For prompt-based tool calling: parse <tool_call> blocks from the accumulated text
      if (usePromptBasedTools && fullText.includes('<tool_call>')) {
        const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        const parsedToolCalls: PendingToolCall[] = [];
        let match;
        while ((match = toolCallRegex.exec(fullText)) !== null) {
          try {
            const parsed = JSON.parse(match[1]);
            if (parsed.name) {
              parsedToolCalls.push({
                id: `prompt_${Date.now()}_${parsedToolCalls.length}`,
                functionName: parsed.name,
                arguments: parsed.arguments || {},
              });
            }
          } catch {
            // Invalid JSON in tool call — skip
          }
        }
        if (parsedToolCalls.length > 0) {
          callbacks.onToolCall?.(parsedToolCalls);
          return;
        }
      }

      callbacks.onEnd();
    } catch (err: any) {
      callbacks.onError(err.message || 'Unknown streaming error');
    }
  }

  private async chatGemini(messages: any[], modelKey: string): Promise<any> {
    if (!this.geminiClient) {
      throw new Error('Gemini API key not configured. Get a free key at ai.google.dev');
    }

    const modelId = this.getModelId(modelKey);
    const model = this.geminiClient.getGenerativeModel({ model: modelId });

    const history = messages.slice(0, -1).map((m: any) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = messages[messages.length - 1];
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage.content);
    const text = result.response.text();

    return { content: text, model: modelId };
  }

  private async streamGemini(
    messages: ChatMessageWithTools[],
    modelKey: string,
    callbacks: StreamCallbacks,
    tools?: ToolDefinition[]
  ): Promise<void> {
    if (!this.geminiClient) {
      throw new Error('Gemini API key not configured. Get a free key at ai.google.dev');
    }

    const modelId = this.getModelId(modelKey);

    // Build model config with optional tool declarations
    const modelConfig: any = { model: modelId };

    if (tools && tools.length > 0) {
      modelConfig.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    const model = this.geminiClient.getGenerativeModel(modelConfig);

    // Filter messages for Gemini format (no 'tool' or 'system' role in history)
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const history = chatMessages.slice(0, -1).map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'function' as const,
          parts: [{
            functionResponse: {
              name: m.name || 'unknown',
              response: { result: m.content },
            },
          }],
        };
      }
      return {
        role: m.role === 'assistant' ? 'model' as const : 'user' as const,
        parts: [{ text: m.content }],
      };
    });

    const lastMessage = chatMessages[chatMessages.length - 1];
    const lastParts = lastMessage.role === 'tool'
      ? [{
          functionResponse: {
            name: lastMessage.name || 'unknown',
            response: { result: lastMessage.content },
          },
        }]
      : [{ text: lastMessage.content }];

    const chat = model.startChat({
      history,
      ...(systemMessage ? { systemInstruction: systemMessage.content } : {}),
    });

    const result = await chat.sendMessageStream(lastParts as any);

    let hasToolCalls = false;
    const pendingToolCalls: PendingToolCall[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        callbacks.onToken(text);
      }

      // Check for function calls
      const candidate = chunk.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ((part as any).functionCall) {
            const fc = (part as any).functionCall;
            hasToolCalls = true;
            pendingToolCalls.push({
              id: `gemini_${Date.now()}_${pendingToolCalls.length}`,
              functionName: fc.name,
              arguments: fc.args || {},
            });
          }
        }
      }
    }

    if (hasToolCalls && pendingToolCalls.length > 0) {
      callbacks.onToolCall?.(pendingToolCalls);
      return; // Don't call onEnd — orchestrator will continue
    }

    callbacks.onEnd();
  }
}
