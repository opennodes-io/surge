// Runtime verification of the ONP integration: AiService discovers models from a
// local OpenNodes registry and streams a chat through a real node with pinned headers.
// Run (from repo root, registry at :4300 with a registered node):
//   pnpm --filter @surge/desktop exec esbuild packages/core/test/verify-onp.ts --bundle --platform=node --format=esm \
//     --external:@google/generative-ai --external:@libsql/client --external:@modelcontextprotocol/sdk --external:openai \
//     --outfile=packages/core/test/verify-onp.bundle.mjs   && node packages/core/test/verify-onp.bundle.mjs
import { AiService } from '../src/ai/ai-service.js';
import { OnpRegistryClient } from '../src/onp/onp-client.js';
import type { SettingsPort } from '../src/ports/index.js';

const settings: SettingsPort = {
  get: (key: string) => ({ 'ai.onpRegistryUrl': 'http://127.0.0.1:4300' } as Record<string, string>)[key],
  set: () => {},
  getTier: () => 'enterprise',
  getMaxConnections: () => 10,
};

const ai = new AiService(settings);

// 1. discovery: ONP models appear in the model list
const models = await ai.listModels();
const onpModels = models.filter((m) => m.provider === 'onp');
console.log(`listModels: ${models.length} total, ${onpModels.length} from the ONP registry`);
const echo = onpModels.find((m) => m.name.includes('Echo'));
if (!echo) throw new Error('expected the fixture Echo model in the ONP list');
console.log(`  picked: ${echo.id} — "${echo.description}" — ${echo.costEstimate}`);

// 2. enforceable pre-pricing
const est = await ai.estimateOnp(echo.id, 1000, 300);
console.log(`  estimate: $${est?.total.min}–${est?.total.max} (rev ${est?.steps[0].card_revision.slice(0, 10)})`);

// 3. invocation: streamed chat through the node with pinned ONP headers
let streamed = '';
await new Promise<void>((resolve, reject) => {
  ai.streamChat(
    [{ role: 'user', content: 'surge native onp path' }],
    echo.id,
    {
      onToken: (t) => { streamed += t; },
      onEnd: () => resolve(),
      onError: (e) => reject(new Error(e)),
    },
  );
});
console.log(`  streamed: ${JSON.stringify(streamed)}`);
if (!streamed.includes('surge native onp path')) throw new Error('unexpected reply');

// 4. the registry client is exported standalone too
const direct = new OnpRegistryClient('http://127.0.0.1:4300');
const verified = await direct.searchOfferings({ tier: 'community' });
console.log(`  direct client: ${verified.length} community+ offerings, first tier=${verified[0]?.tier}`);

console.log('STEP 1: PASS — native ONP provider inside @surge/core (discover → estimate → pinned stream)');
