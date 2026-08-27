// Step 0 verification: Surge's exact vllm-custom call path against the onp gateway.
// Mirrors AiService.initClients (vllm branch) + streamChat params verbatim.
import OpenAI from 'openai';

// what a user would put in Surge settings:
const settings = {
  'ai.vllmEndpoint': 'http://127.0.0.1:4141', // the onp gateway
  'ai.vllmApiKey': '',                        // gateway runs open locally
  'ai.vllmModel': 'org.opennodes.fixture/echo-1',
};

let baseURL = settings['ai.vllmEndpoint'].trim().replace(/\/+$/, '');
if (!baseURL.endsWith('/v1')) baseURL += '/v1';
const client = new OpenAI({ apiKey: settings['ai.vllmApiKey'] || 'not-required', baseURL });

// model list as Surge could enumerate it
const models = await client.models.list();
console.log('models via SDK:', models.data.map((m) => m.id));

// streamChat-shaped request (temperature 0.7, max_tokens 4096, stream: true)
const stream = await client.chat.completions.create({
  model: settings['ai.vllmModel'],
  messages: [{ role: 'user', content: 'hello from Surge via OpenNodes' }],
  temperature: 0.7,
  max_tokens: 4096,
  stream: true,
});
let text = '';
for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (delta) text += delta;
}
console.log('streamed reply:', JSON.stringify(text));
console.log('STEP 0: PASS — Surge vllm-custom settings pointed at the onp gateway work unchanged');
