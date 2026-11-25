// Stub adapter for a future licensed index provider. Implement fetchPrints() to return
// [{symbol, date: "YYYY-MM-DD", value}] (value in index points). Keep provider credentials
// in env (e.g. PRICE_HTTP_TOKEN) and never log them.
export class HttpPriceSource {
  constructor(url, { token = process.env.PRICE_HTTP_TOKEN, mapResponse } = {}) {
    this.url = url; this.token = token; this.name = `http:${url}`;
    // Default mapping expects the provider to already return [{symbol,date,value}].
    this.mapResponse = mapResponse ?? ((json) => json);
  }
  async fetchPrints() {
    if (!this.url) throw new Error("PRICE_HTTP_URL not set (HTTP source is a stub; wire up your data provider)");
    const res = await fetch(this.url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new Error(`price provider HTTP ${res.status}`);
    return this.mapResponse(await res.json());
  }
}
