export type ApiResult<T = any> = { http: number; body: T };

export class ForkosApi {
  constructor(
    readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<ApiResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { http: res.status, body: text ? JSON.parse(text) : {} };
  }

  private async ok<T = any>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const r = await this.call<T>(method, path, body, extra);
    if (r.http >= 400) throw new Error(`${method} ${path} → ${r.http} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  config() {
    return this.ok('GET', '/v1/config');
  }
  me() {
    return this.ok<{ agentAddr: string; humanHash: string; accountId: string; epoch: number; status: string; label: string }>('GET', '/v1/me/agent');
  }
  job(jobKey: string) {
    return this.ok('GET', `/v1/jobs/${jobKey}`);
  }
  directory() {
    return this.ok<{ services: { providerId: string; name: string; price: string; endpoint: string; payTo: string; asset: string }[] }>('GET', '/v1/directory');
  }
  /** `agentkit`: optional World AgentKit header signed by this agent; the payer relays it to the provider. */
  pay(body: { jobKey: string; round: number; audioUrl: string; inputHash: string; agentkit?: string }) {
    return this.call('POST', '/v1/pay', body);
  }
  demoJob(demoKey: string) {
    return this.ok<{ audioUrl: string; inputHash: string }>('POST', '/v1/demo/job', {}, { 'x-demo-key': demoKey });
  }
  counter(jobKey: string, since: number) {
    return this.ok('GET', `/v1/counter?jobKey=${jobKey}&since=${since}`);
  }

  linkStart(body: { agentAddr: string; publicKeyHex: string; label: string; pairingCode?: string }) {
    return this.ok<{ linkId: string; userCode: string; verificationUri: string; verificationUriComplete: string | null }>(
      'POST',
      '/v1/agents/link/start',
      body,
    );
  }
  async linkWait(linkId: string): Promise<{ agentToken: string; agent: { agentAddr: string; accountId: string; epoch: number; humanHash: string } }> {
    for (;;) {
      const r = await this.ok<any>('GET', `/v1/agents/link/${linkId}`);
      if (r.status === 'LINKED') return r;
      if (['DENIED', 'EXPIRED', 'FAILED'].includes(r.status)) throw new Error(`link ${r.status}: ${r.reason ?? ''}`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
