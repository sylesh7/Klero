import { canonicalJson, inputHashOf, sha256Hex } from '@forkos/shared';
import OpenAI, { toFile } from 'openai';
import { env } from './config';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const MAX_BYTES = 24 * 1024 * 1024; // Whisper upload limit is 25 MB

export class InputHashMismatch extends Error {}

export async function fetchAudio(url: string, expectedHash: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('audio too large');
  const got = inputHashOf(buf);
  if (got !== expectedHash) throw new InputHashMismatch(`inputHash mismatch: got ${got}`);
  return buf;
}

export async function transcribeAndSummarize(audio: Uint8Array): Promise<{ transcript: string; summary: string; outputHash: string }> {
  const file = await toFile(audio, 'meeting.mp3', { type: 'audio/mpeg' });
  const tr = await openai.audio.transcriptions.create({ file, model: env.OPENAI_STT_MODEL });
  const transcript = tr.text;
  const chat = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Summarize this meeting transcript as 3-6 short bullet points: decisions first, then action items with owners.',
      },
      { role: 'user', content: transcript.slice(0, 24_000) },
    ],
  });
  const summary = chat.choices[0]?.message?.content?.trim() ?? '';
  const outputHash = sha256Hex(canonicalJson({ transcript, summary }));
  return { transcript, summary, outputHash };
}
