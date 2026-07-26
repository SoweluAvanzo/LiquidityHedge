/**
 * Candle storage port (AR-3/AR-4). The dev implementation is file-backed
 * (one JSON file per address+timeframe); production swaps in a Postgres
 * adapter behind the same interface without touching consumers.
 */

import * as fs from "fs";
import * as path from "path";
import { Candle, Timeframe } from "./types";

export interface CandleStore {
  upsert(address: string, timeframe: Timeframe, candles: Candle[]): Promise<number>;
  read(
    address: string,
    timeframe: Timeframe,
    timeFrom: number,
    timeTo: number,
  ): Promise<Candle[]>;
  /** Latest stored candle time, or null when empty. */
  latest(address: string, timeframe: Timeframe): Promise<number | null>;
}

export class FileCandleStore implements CandleStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(address: string, timeframe: Timeframe): string {
    // address is base58, timeframe is a fixed enum — both filesystem-safe.
    return path.join(this.dir, `${address}_${timeframe}.json`);
  }

  private load(address: string, timeframe: Timeframe): Map<number, Candle> {
    const f = this.file(address, timeframe);
    if (!fs.existsSync(f)) return new Map();
    const arr: Candle[] = JSON.parse(fs.readFileSync(f, "utf8"));
    return new Map(arr.map((c) => [c.t, c]));
  }

  async upsert(
    address: string,
    timeframe: Timeframe,
    candles: Candle[],
  ): Promise<number> {
    const byTime = this.load(address, timeframe);
    let added = 0;
    for (const c of candles) {
      if (!byTime.has(c.t)) added++;
      byTime.set(c.t, c);
    }
    const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
    const f = this.file(address, timeframe);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sorted));
    fs.renameSync(tmp, f); // atomic on POSIX — no torn reads
    return added;
  }

  async read(
    address: string,
    timeframe: Timeframe,
    timeFrom: number,
    timeTo: number,
  ): Promise<Candle[]> {
    return [...this.load(address, timeframe).values()]
      .filter((c) => c.t >= timeFrom && c.t <= timeTo)
      .sort((a, b) => a.t - b.t);
  }

  async latest(address: string, timeframe: Timeframe): Promise<number | null> {
    const all = this.load(address, timeframe);
    if (all.size === 0) return null;
    return Math.max(...all.keys());
  }
}
