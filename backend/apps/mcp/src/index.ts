#!/usr/bin/env -S npx tsx
// stdio MCP server. NEVER write to stdout except via the MCP transport (use console.error for logs).
import { ForkosAgent } from '@forkos/agent-kit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`forkos-mcp: missing ${k}`);
  return v;
};

const agent = await new ForkosAgent({
  key: need('FORKOS_AGENT_KEY') as `0x${string}`,
  token: need('FORKOS_AGENT_TOKEN'),
  apiUrl: need('FORKOS_API_URL'),
  log: (m, e) => console.error(`[forkos] ${m}`, e ?? ''),
}).init();

const server = new McpServer({ name: 'forkos', version: '0.1.0' });
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });

server.registerTool(
  'forkos_whoami',
  { title: 'ForkOS identity', description: 'Shows this agent, its human (hash), Hedera account and authority epoch.' },
  async () => text(await agent.api.me()),
);

server.registerTool(
  'forkos_services',
  { title: 'Paid services', description: 'Lists x402 transcription services from the Hedera HCS directory (registered providers only) with prices.' },
  async () => text((await agent.discover()).map((s) => ({ providerId: s.providerId, name: s.name, price: s.price.toString(), endpoint: s.endpoint }))),
);

server.registerTool(
  'forkos_buy_transcription',
  {
    title: 'Buy a transcription (exactly once)',
    description:
      'Transcribes and summarizes an audio URL through a paid x402 service. ForkOS guarantees your human pays at most once for the same audio, even if other agents of the same human try too. Over-cap payments ask the human on their phone.',
    inputSchema: { audioUrl: z.string().url(), providerId: z.string().optional() },
  },
  async ({ audioUrl, providerId }) => {
    const out = await agent.buy(audioUrl, (services) => {
      const pick = providerId ? services.find((s) => s.providerId === providerId) : [...services].sort((a, b) => (a.price < b.price ? -1 : 1))[0];
      if (!pick) throw new Error('no matching service in the directory');
      return pick;
    });
    return text(out);
  },
);

await server.connect(new StdioServerTransport());
