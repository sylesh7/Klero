// Usage: pnpm agents [count]   → races the linked agents in .secrets/agents.json on the sample meeting
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForkosAgent, ForkosApi } from '@forkos/agent-kit';
import { llmChoose, PERSONAS } from './choose';

const store = JSON.parse(readFileSync(join(process.cwd(), '..', '..', '.secrets', 'agents.json'), 'utf8')) as Record<
  string,
  { key: `0x${string}`; token?: string }
>;
const linked = Object.entries(store).filter(([, v]) => v.token);
const count = Number(process.argv[2] ?? linked.length);
const apiUrl = process.env.FORKOS_API_URL ?? 'http://localhost:4040';
const since = Math.floor(Date.now() / 1000) - 5;

const job = await new ForkosApi(apiUrl).demoJob(process.env.DEMO_KEY!);
console.log('job audio:', job.audioUrl, job.inputHash);

const results = await Promise.all(
  linked.slice(0, count).map(async ([label, v], i) => {
    const agent = await new ForkosAgent({ key: v.key, token: v.token!, apiUrl }).init();
    const out = await agent.buy(job.audioUrl, (services) => llmChoose(PERSONAS[i % PERSONAS.length]!, services));
    agent.close();
    return { label, kind: out.kind };
  }),
);
console.table(results);

const anyAgent = linked[0]![1];
const api = new ForkosApi(apiUrl, anyAgent.token);
const me = await api.me();
const { jobKeyOf } = await import('@forkos/shared');
const jobKey = jobKeyOf(me.humanHash, job.inputHash);
console.log('Mirror Node counter:', JSON.stringify((await api.counter(jobKey, since)).forkos));
