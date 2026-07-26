/**
 * Model registry (FR-S5): the UI and engine discover models here and
 * render config forms from each model's JSON Schema. Adding a model =
 * one registration line; no engine or UI changes.
 */

import { RiskModel, RiskModelDescriptor } from "./model";
import { GbmModel } from "./models/gbm";
import { EmpiricalBootstrapModel } from "./models/bootstrap";
import { HistoricalReplayModel } from "./models/historical-replay";

const registry = new Map<string, () => RiskModel<any, any>>([
  ["gbm", () => new GbmModel()],
  ["empirical-bootstrap", () => new EmpiricalBootstrapModel()],
  ["historical-replay", () => new HistoricalReplayModel()],
]);

export function listModels(): RiskModelDescriptor[] {
  return [...registry.values()].map((f) => f().describe());
}

export function getModel(id: string): RiskModel<any, any> {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(
      `unknown risk model "${id}" — available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory();
}
