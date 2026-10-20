#!/usr/bin/env node
// Local MCP server over stdio, for Claude Code or Claude Desktop on this
// machine without hosting anything:
//   claude mcp add tracker -s user -e GITHUB_TOKEN=… -e TRACKER_REPO=owner/repo -- node /path/to/mcp/stdio.js
import { createInterface } from 'node:readline';
import { configProblems, createServerFromEnv } from './server.js';

const { config, handle } = createServerFromEnv(process.env);
for (const problem of configProblems(config)) console.error(`tracker-mcp: ${problem}`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const batch = Array.isArray(message);
  const responses = (await Promise.all((batch ? message : [message]).map(handle))).filter(Boolean);
  if (responses.length) send(batch ? responses : responses[0]);
});
