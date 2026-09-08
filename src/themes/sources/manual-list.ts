/**
 * ManualListSignalSource — a static list of symbols with target actions.
 *
 * The simplest signal source: returns a fixed list of buy/sell/hold
 * signals. Useful for "buy and hold these 10 stocks" themes and for
 * testing the theme framework.
 */

import type { SignalSource } from "../signal-source.js";
import type { ThemeSignal } from "../theme.js";

export interface ManualListEntry {
  symbol: string;
  action: "buy" | "sell" | "hold";
  reason: string;
  suggestedQuantity?: number;
}

export class ManualListSignalSource implements SignalSource {
  readonly name = "manual-list";
  private entries: ManualListEntry[];

  constructor(entries: ManualListEntry[]) {
    this.entries = entries;
  }

  async fetchSignals(): Promise<ThemeSignal[]> {
    return this.entries.map((e) => ({
      symbol: e.symbol,
      action: e.action,
      reason: e.reason,
      suggestedQuantity: e.suggestedQuantity,
    }));
  }
}