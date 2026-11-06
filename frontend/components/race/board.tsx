'use client';
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { formatToken, short } from '@/lib/format';
import type { Agent } from '@/lib/types';

const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | 'neon' | undefined> = { OPEN: 'info', WON: 'neon', PAYING: 'warn', PAID: 'ok', LOST: undefined, VOID: 'bad' };

export function Board({ jobKey, agents, winnerSeq }: { jobKey: string; agents: Agent[]; winnerSeq?: number }) {
  const { cfg } = useConfig();
  const q = useQuery({ queryKey: ['race', 'board', jobKey], queryFn: () => api.board(jobKey), refetchInterval: 4000, refetchIntervalInBackground: true });
  const label = (addr: string) => agents.find((a) => a.agentAddr.toLowerCase() === addr.toLowerCase())?.label ?? short(addr);
  const rows = [...(q.data?.claims ?? [])].sort((a, b) => a.round - b.round || a.seq - b.seq);
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow"><Boxes size={12} /> Claim board · read from Arkiv</span>
        <span className="small muted">entities owned by each agent’s wallet · auto-expire</span>
      </div>
      <div className="feed">
        <table className="tbl">
          <thead><tr><th>r</th><th>Agent</th><th>Service</th><th>Price</th><th>Status</th><th>HCS</th><th>Owner (wallet)</th><th>Expires</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.key} className={c.seq && c.seq === winnerSeq ? 'win' : c.status === 'VOID' ? 'void' : ''}>
                <td>{c.round}</td>
                <td><b>{label(c.agent)}</b></td>
                <td className="mono">{c.svc}</td>
                <td className="mono">{formatToken(c.price, cfg?.assetDecimals ?? 6)}</td>
                <td><Pill tone={TONE[c.status]}>{c.status}</Pill></td>
                <td className="mono">{c.seq ? `#${c.seq}` : '…'}</td>
                <td className="mono" title={c.owner}>{short(c.owner)}</td>
                <td className="mono small">{c.expiresAt}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">No claims on Arkiv for this job yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <span className="small muted">Expires is Arkiv’s own <code>$expiresAt</code> as returned. Rows disappear by themselves when it passes (30 s for losers).</span>
    </div>
  );
}
