import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WEB_ORIGINS } from './config';
import { sql } from './db';

const clients = new Set<ServerResponse>();

/** Persist + broadcast. Data must be JSON-safe (convert bigint to string before calling). */
export async function emit(name: string, data: Record<string, unknown>): Promise<void> {
  const [row] = await sql<{ id: string }[]>`insert into events (name, data) values (${name}, ${sql.json(data as never)}) returning id`;
  const frame = `id: ${row!.id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}

export function registerSse(app: FastifyInstance) {
  app.get('/v1/events', async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    if (origin && (WEB_ORIGINS.includes(origin) || WEB_ORIGINS.includes('*'))) headers['access-control-allow-origin'] = origin;
    raw.writeHead(200, headers);

    // Replay: after Last-Event-ID, else the last 100 events.
    const last = Number(req.headers['last-event-id'] ?? 0);
    const backlog = last
      ? await sql<{ id: string; name: string; data: unknown }[]>`select id, name, data from events where id > ${last} order by id asc limit 500`
      : (await sql<{ id: string; name: string; data: unknown }[]>`select id, name, data from events order by id desc limit 100`).reverse();
    for (const e of backlog) raw.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e.data)}\n\n`);

    clients.add(raw);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(raw);
    });
  });
}
