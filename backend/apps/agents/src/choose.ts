import type { ServiceRow } from '@forkos/shared';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Real LLM decision: pick one providerId from the directory, given a persona. */
export async function llmChoose(persona: string, services: ServiceRow[]): Promise<ServiceRow> {
  const list = services.map((s) => ({ providerId: s.providerId, name: s.name, priceFUSD: Number(s.price) / 1e6 }));
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `You are a procurement agent. ${persona} Reply as JSON {"providerId": "...", "why": "..."}.` },
      { role: 'user', content: `Task: transcribe and summarize a meeting recording. Services: ${JSON.stringify(list)}` },
    ],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as { providerId?: string; why?: string };
  const pick = services.find((s) => s.providerId === parsed.providerId) ?? services[0]!;
  console.log(`  LLM (${persona.slice(0, 24)}…) chose ${pick.providerId}: ${parsed.why ?? ''}`);
  return pick;
}

export const PERSONAS = [
  'You always pick the cheapest option.',
  'You prefer the provider whose name sounds most reliable; price matters less.',
  'You prefer the premium option when the meeting might be important.',
];
