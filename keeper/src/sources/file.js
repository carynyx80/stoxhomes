// File price source: JSON array [{symbol, date, value}] or CSV with header symbol,date,value.
import fs from "node:fs";

export class FilePriceSource {
  constructor(file) { this.file = file; this.name = `file:${file}`; }
  /** @returns {Promise<Array<{symbol:string,date:string,value:number}>>} */
  async fetchPrints() {
    const raw = fs.readFileSync(this.file, "utf8");
    let rows;
    if (this.file.endsWith(".csv")) {
      const [head, ...lines] = raw.split(/\r?\n/).filter((l) => l.trim());
      const cols = head.split(",").map((c) => c.trim().toLowerCase());
      rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v.trim()])));
    } else rows = JSON.parse(raw);
    return rows.map((r) => ({ symbol: String(r.symbol).toUpperCase(), date: String(r.date), value: Number(r.value) }))
      .filter((r) => r.symbol && r.date && Number.isFinite(r.value) && r.value > 0);
  }
}
