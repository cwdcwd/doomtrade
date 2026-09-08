/**
 * Themes module — barrel export + strategy registration helpers.
 *
 * Strategies and signal sources are exported from their subdirectories.
 * Use `registerAllStrategies()` to wire every available strategy into
 * a ThemeRunner instance.
 */

// Core types
export type {
  ThemeSignal,
  ThemeSchedule,
  ThemeConfig,
  ThemeEvaluationResult,
  ThemePerformance,
} from "./theme.js";

export type { ThemeStrategy, ThemeContext } from "./strategy.js";
export type { SignalSource } from "./signal-source.js";

// Infrastructure
export { ThemeStore } from "./theme-store.js";
export type { CreateThemeInput } from "./theme-store.js";
export { ThemeSubAccount } from "./theme-sub-account.js";
export { ThemeRunner } from "./theme-runner.js";
export type { ThemeRunnerOptions } from "./theme-runner.js";

// Signal sources
export { ManualListSignalSource } from "./sources/manual-list.js";
export type { ManualListEntry } from "./sources/manual-list.js";
export { MomentumScreenSignalSource } from "./sources/momentum-screen.js";
export type { MomentumScreenConfig, MomentumMethod } from "./sources/momentum-screen.js";
export { AgentSignalSource } from "./sources/agent-signal.js";
export type { AgentSignalConfig } from "./sources/agent-signal.js";

// Strategies
export { MomentumRotationStrategy } from "./strategies/momentum-rotation.js";
export { AgentDrivenStrategy } from "./strategies/agent-driven.js";

// Services needed for strategy construction
import type { ThemeRunner } from "./theme-runner.js";
import type { ResearchService } from "../research/research.js";
import type { AgentCoordinator } from "../integration/agent-integration.js";
import { MomentumRotationStrategy } from "./strategies/momentum-rotation.js";
import { AgentDrivenStrategy } from "./strategies/agent-driven.js";

/**
 * Register all available strategies with the ThemeRunner.
 *
 * @param runner   The ThemeRunner instance
 * @param research  ResearchService for market analysis
 * @param coordinator AgentCoordinator for A2A communication (optional —
 *                     agent-driven strategy is skipped if not provided)
 */
export function registerAllStrategies(
  runner: ThemeRunner,
  research: ResearchService,
  coordinator?: AgentCoordinator,
): void {
  runner.registerStrategy(new MomentumRotationStrategy());

  if (coordinator) {
    runner.registerStrategy(new AgentDrivenStrategy(coordinator, research));
  }
}