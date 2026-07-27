export * from "./model";
export { makeRng } from "./rng";
export type { Rng } from "./rng";
export { GbmModel, cholesky } from "./models/gbm";
export type { GbmConfig, GbmParams, DriftMode } from "./models/gbm";
export { EmpiricalBootstrapModel } from "./models/bootstrap";
export type { BootstrapConfig, BootstrapParams, BootstrapMode } from "./models/bootstrap";
export { simulatePortfolio, quantile } from "./engine";
export type { SimPosition, SimulationReport, TerminalStats, FanSeries, Composition, SimulateOptions } from "./engine";
export { listModels, getModel } from "./registry";
export { HistoricalReplayModel } from "./models/historical-replay";
export type { ReplayConfig, ReplayParams, ReplayMode } from "./models/historical-replay";
export {
  calibrateFeeIntensity,
  sampleRatePaths,
  sampleSharedBlockIndices,
  ratePathsFromIndices,
} from "./models/fee-intensity";
export type { FeeIntensityParams } from "./models/fee-intensity";
export {
  calibrateCoupledFeeIntensity,
  sampleCoupledRatePaths,
  absLogReturns,
} from "./models/fee-intensity";
export type { CoupledFeeIntensityParams } from "./models/fee-intensity";
export { correlationReport, pearson, normalCdf } from "./stats/correlation";
export type { CorrelationReport, CorrelationPair } from "./stats/correlation";
