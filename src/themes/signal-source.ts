/**
 * Signal source interface for experimental themes.
 *
 * Signal sources are pluggable data providers that feed signals to
 * strategies. A strategy may use one or more signal sources to
 * gather the data it needs to make decisions.
 */

import type { ThemeSignal } from "./theme.js";

/**
 * A signal source provides ThemeSignals on demand.
 *
 * Implementations:
 * - CongressTradesSignalSource (Bargo API)
 * - MomentumScreenSignalSource (ResearchService)
 * - AgentSignalSource (A2A agent delegation)
 * - ManualListSignalSource (static symbol list)
 */
export interface SignalSource {
  /** Source name for logging and attribution */
  readonly name: string;

  /**
   * Fetch current signals from this source.
   * Called by strategies during evaluation.
   */
  fetchSignals(): Promise<ThemeSignal[]>;
}
