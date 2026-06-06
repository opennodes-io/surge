import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { openStore } from './store.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT ?? process.env.SURGE_MCP_HTTP_PORT ?? 3939);

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function main(): Promise<void> {
  const store = await openStore();
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      const body = await readBody(req);
      let transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No session; send initialize first' }, id: null }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport!;
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) delete transports[transport!.sessionId];
        };
        const server = createServer(store);
        await server.connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        res.writeHead(400);
        res.end('Unknown or missing session id');
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  });

  httpServer.listen(PORT, () => {
    process.stderr.write(`[surge-bookmarks-mcp] HTTP (streamable) listening on http://localhost:${PORT}/mcp\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`[surge-bookmarks-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
