// Generates services/provider/public/sample-meeting.mp3 (~45 s) with OpenAI TTS. Run once, commit the file.
import { writeFileSync } from 'node:fs';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const script = `Okay, let's start the weekly sync. First item: the payments launch.
Priya says the checkout integration is done and tested on testnet.
We agreed to ship it next Tuesday, not Friday, because the audit notes come back Monday.
Second item: the support backlog. Rahul will triage the forty open tickets by Thursday,
and anything about refunds goes to finance first.
Third item: the AI agent pilot. The agents kept paying twice when the network timed out,
so we are adding an exactly-once payment layer before we give them a bigger budget.
Action items: Priya ships checkout Tuesday. Rahul clears the backlog Thursday.
Austin owns the agent payment fix. That's it, thanks everyone.`;

const speech = await openai.audio.speech.create({
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  input: script,
  response_format: 'mp3',
});
const bytes = Buffer.from(await speech.arrayBuffer());
writeFileSync('services/provider/public/sample-meeting.mp3', bytes);
console.log('wrote services/provider/public/sample-meeting.mp3', bytes.length, 'bytes');
