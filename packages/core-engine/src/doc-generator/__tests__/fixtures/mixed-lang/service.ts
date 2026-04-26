/** TypeScript side of the mixed-language fixture. */
export interface AnalyticsEvent {
  readonly name: string;
  readonly properties: Record<string, unknown>;
}

export class AnalyticsClient {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async track(event: AnalyticsEvent): Promise<void> {
    await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  }
}
