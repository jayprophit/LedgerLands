import type { AetheriusAppManifest } from "@ledgerlands/shared-types";

export interface AetheriusClientOptions {
  endpoint: string;
  appToken?: string;
  fetchImpl?: typeof fetch;
}

export class AetheriusClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AetheriusClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): HeadersInit {
    return {
      "content-type": "application/json",
      ...(this.options.appToken ? { authorization: `Bearer ${this.options.appToken}` } : {}),
    };
  }

  async registerApplication(manifest: AetheriusAppManifest): Promise<Response> {
    return this.fetchImpl(`${this.options.endpoint}/v1/applications/register`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(manifest),
    });
  }

  async notify(payload: { recipient: string; title: string; message: string; action?: string }): Promise<Response> {
    return this.fetchImpl(`${this.options.endpoint}/v1/notifications`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ source: "com.aetherius.ledgerlands", ...payload }),
    });
  }

  async search(query: string): Promise<Response> {
    return this.fetchImpl(`${this.options.endpoint}/v1/search?q=${encodeURIComponent(query)}`, {
      headers: this.headers(),
    });
  }
}
