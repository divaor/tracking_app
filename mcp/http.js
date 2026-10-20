#!/usr/bin/env node
// Self-hosted HTTP MCP server (any machine with Node 20+). Put it behind HTTPS
// (a tunnel or reverse proxy) to use it as a Claude custom connector.
//   MCP_SECRET=… GITHUB_TOKEN=… TRACKER_REPO=owner/repo node mcp/http.js
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handleHttp } from './protocol.js';
import { configProblems, createServerFromEnv } from './server.js';

const { config, handle } = createServerFromEnv(process.env);
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';

for (const problem of configProblems(config)) console.warn(`Warning: ${problem}`);
if (config.secret.length < 16) console.warn('Warning: MCP_SECRET must be set (16+ characters) or every request is refused.');

createServer(async (req, res) => {
  try {
    const request = new Request(new URL(req.url, `http://${req.headers.host ?? 'localhost'}`), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req),
      duplex: 'half',
    });
    const response = await handleHttp(request, { handle, secret: config.secret, allowedOrigins: config.allowedOrigins });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end();
  }
}).listen(port, host, () => console.log(`Tracker MCP server on http://${host}:${port}/mcp/<MCP_SECRET>`));
