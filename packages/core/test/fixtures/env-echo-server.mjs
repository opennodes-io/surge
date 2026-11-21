// A dependency-free stdio MCP server for verify-discovery.ts: one tool, `env`, that answers with the
// names and values of its own environment, so the test can see what a stdio server was started with.
// Newline-delimited JSON-RPC, as the stdio transport speaks it.
import readline from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications (initialized, cancelled)
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-echo', version: '1.0.0' } } });
    case 'tools/list':
      return send({ id: m.id, result: { tools: [{ name: 'env', description: "Report this process's environment", inputSchema: { type: 'object', properties: {} } }] } });
    case 'tools/call':
      return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(process.env) }] } });
    case 'ping':
      return send({ id: m.id, result: {} });
    default:
      return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
});
