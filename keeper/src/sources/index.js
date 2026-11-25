import { FilePriceSource } from "./file.js";
import { HttpPriceSource } from "./http.js";
export function makeSource(cfg) {
  if (cfg.priceSource === "file") return new FilePriceSource(cfg.pricesFile);
  if (cfg.priceSource === "http") return new HttpPriceSource(cfg.priceHttpUrl);
  throw new Error(`unknown PRICE_SOURCE ${cfg.priceSource}`);
}
export { FilePriceSource, HttpPriceSource };
