export const API_SOAK_CSV_THRESHOLDS = Object.freeze({
  minimumDurationSeconds: 1_800,
  maximumTotalSeconds: 2_400,
  cycleIntervalSeconds: 20,
  expectedCycles: 90,
  rowsPerCycle: 100_000,
  failureEveryCycles: 10,
  expectedFailureProbeCycles: 9,
  rotatingFileSlots: 5,
  minimumTotalRows: 9_000_000,
  minimumTotalBytes: 1_000_000_000,
  minimumCycleGapMs: 18_000,
  maximumCycleGapMs: 30_000,
  perUploadSeconds: 30,
  p95UploadSeconds: 10,
  latencyTrendMultiplier: 2,
  latencyTrendFloorSeconds: 5,
  sampleIntervalMs: 5_000,
  maximumSampleIntervalMs: 7_500,
  minimumResourceSamples: 300,
  trendWindowSamples: 60,
  apiPeakMemoryBytes: 1024 ** 3,
  postgresPeakMemoryBytes: 2 * 1024 ** 3,
  clientPeakWorkingSetBytes: 512 * 1024 ** 2,
  apiMedianGrowthBytes: 256 * 1024 ** 2,
  postgresMedianGrowthBytes: 512 * 1024 ** 2,
  clientMedianGrowthBytes: 256 * 1024 ** 2,
  databaseGrowthBytes: 256 * 1024 ** 2,
});

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function isSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value ?? ""));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sameNumber(left: unknown, right: number): boolean {
  return Math.abs(finite(left) - right) < 0.000_001;
}

type ResourceMetrics = {
  peak: number;
  medianGrowth: number;
  cadenceValid: boolean;
  coverageValid: boolean;
};

function resourceMetrics(samples: any[], workloadStart: number, workloadFinish: number): ResourceMetrics {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { peak: Number.NaN, medianGrowth: Number.NaN, cadenceValid: false, coverageValid: false };
  }
  const timestamps = samples.map((sample) => finite(sample?.atEpochMs));
  const memories = samples.map((sample) => finite(sample?.memoryBytes));
  const window = API_SOAK_CSV_THRESHOLDS.trendWindowSamples;
  let cadenceValid = timestamps.every((timestamp) => Number.isSafeInteger(timestamp));
  for (let index = 1; index < timestamps.length; index++) {
    const gap = timestamps[index] - timestamps[index - 1];
    if (!(gap > 0 && gap <= API_SOAK_CSV_THRESHOLDS.maximumSampleIntervalMs)) cadenceValid = false;
  }
  const coverageValid = timestamps[0] <= workloadStart + API_SOAK_CSV_THRESHOLDS.maximumSampleIntervalMs
    && timestamps.at(-1)! >= workloadFinish - API_SOAK_CSV_THRESHOLDS.maximumSampleIntervalMs;
  return {
    peak: Math.max(...memories),
    medianGrowth: samples.length >= window * 2
      ? median(memories.slice(-window)) - median(memories.slice(0, window))
      : Number.NaN,
    cadenceValid,
    coverageValid,
  };
}

export function validateApiSoakCsvEvidence(evidence: any): string[] {
  const issues: string[] = [];
  if (evidence?.schema !== "api-soak-csv-upload-evidence/v1") issues.push("evidence schema is invalid");
  const provenance = evidence?.provenance ?? {};
  if (!/^[a-f0-9]{40}$/.test(String(provenance.sourceCommit ?? ""))) issues.push("sourceCommit is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(provenance.runtimeImageDigest ?? ""))) {
    issues.push("runtime image digest is invalid");
  }

  const observation = evidence?.observation;
  if (observation?.schema !== "api-soak-csv-upload-observation/v1") issues.push("observation schema is invalid");
  if (observation?.provenance?.sourceCommit !== provenance.sourceCommit) {
    issues.push("observation sourceCommit differs from final evidence");
  }
  if (observation?.provenance?.runtimeImageDigest !== provenance.runtimeImageDigest) {
    issues.push("observation runtime image digest differs from final evidence");
  }

  const workload = observation?.workload;
  if (workload?.schema !== "api-soak-csv-upload-result/v1") issues.push("workload schema is invalid");
  const boundary = workload?.boundary ?? {};
  if (boundary.transport !== "HTTP chunked raw text/csv") issues.push("transport must be HTTP chunked raw text/csv");
  if (finite(boundary.targetDurationSeconds) !== API_SOAK_CSV_THRESHOLDS.minimumDurationSeconds) {
    issues.push("target soak duration must equal 1800 seconds");
  }
  if (finite(boundary.cycleIntervalSeconds) !== API_SOAK_CSV_THRESHOLDS.cycleIntervalSeconds) {
    issues.push("cycle interval must equal 20 seconds");
  }
  if (finite(boundary.targetCycles) !== API_SOAK_CSV_THRESHOLDS.expectedCycles) issues.push("target cycles must equal 90");
  if (finite(boundary.rowsPerCycle) !== API_SOAK_CSV_THRESHOLDS.rowsPerCycle) issues.push("rows per cycle must equal 100000");
  if (finite(boundary.failureEveryCycles) !== API_SOAK_CSV_THRESHOLDS.failureEveryCycles) {
    issues.push("failure cadence must equal every 10 cycles");
  }
  if (finite(boundary.rotatingFileSlots) !== API_SOAK_CSV_THRESHOLDS.rotatingFileSlots) {
    issues.push("rotating filename slots must equal 5");
  }
  if (boundary.ordinaryUploadCovered !== false) issues.push("evidence must not claim ordinary upload coverage");
  if (boundary.concurrencyCovered !== false) issues.push("evidence must not claim burst concurrency coverage");
  if (boundary.longDurationCovered !== true) issues.push("evidence must claim the measured long-duration coverage");
  if (boundary.realDataCovered !== false) issues.push("evidence must not claim real-data coverage");
  if (boundary.productionSlaCovered !== false) issues.push("evidence must not claim production SLA coverage");

  const startedAtEpochMs = finite(workload?.startedAtEpochMs);
  const finishedAtEpochMs = finite(workload?.finishedAtEpochMs);
  const calculatedDuration = (finishedAtEpochMs - startedAtEpochMs) / 1000;
  if (
    !Number.isSafeInteger(startedAtEpochMs)
    || !Number.isSafeInteger(finishedAtEpochMs)
    || !sameNumber(workload?.actualDurationSeconds, calculatedDuration)
    || calculatedDuration < API_SOAK_CSV_THRESHOLDS.minimumDurationSeconds
  ) {
    issues.push("soak duration is below threshold");
  }
  if (calculatedDuration > API_SOAK_CSV_THRESHOLDS.maximumTotalSeconds) issues.push("soak duration exceeds threshold");

  const cycles = Array.isArray(workload?.cycles) ? workload.cycles : [];
  if (cycles.length !== API_SOAK_CSV_THRESHOLDS.expectedCycles) issues.push("soak must contain exactly 90 cycles");
  const cycleNumbers = new Set<number>();
  const filenames = new Set<string>();
  const hashes = new Set<string>();
  const sourceIds = new Set<number>();
  const latencies: number[] = [];
  const startGaps: number[] = [];
  let totalRows = 0;
  let totalBytes = 0;
  let failureProbeCycles = 0;
  let cycleIntegrityValid = cycles.length === API_SOAK_CSV_THRESHOLDS.expectedCycles;
  let recoveryValid = true;
  let cleanupValid = true;

  for (let index = 0; index < cycles.length; index++) {
    const item = cycles[index];
    const cycleNumber = finite(item?.cycle);
    cycleNumbers.add(cycleNumber);
    filenames.add(String(item?.fileName ?? ""));
    hashes.add(String(item?.sha256 ?? ""));
    sourceIds.add(finite(item?.sourceId));
    const seconds = finite(item?.seconds);
    latencies.push(seconds);
    totalRows += finite(item?.rowCount);
    totalBytes += finite(item?.byteCount);
    if (
      cycleNumber !== index + 1
      || finite(item?.status) !== 200
      || finite(item?.rowCount) !== API_SOAK_CSV_THRESHOLDS.rowsPerCycle
      || finite(item?.previewTotal) !== API_SOAK_CSV_THRESHOLDS.rowsPerCycle
      || item?.firstRowNo !== "1"
      || item?.lastRowNo !== "100000"
      || !(finite(item?.byteCount) > 0)
      || finite(item?.serverByteCount) !== finite(item?.byteCount)
      || !isSha256(item?.sha256)
      || item?.serverSha256 !== item?.sha256
      || !(seconds > 0 && seconds <= API_SOAK_CSV_THRESHOLDS.perUploadSeconds)
      || !Number.isSafeInteger(finite(item?.sourceId))
      || finite(item?.sourceId) <= 0
      || !Number.isSafeInteger(finite(item?.startedAtEpochMs))
      || !Number.isSafeInteger(finite(item?.finishedAtEpochMs))
      || finite(item?.finishedAtEpochMs) <= finite(item?.startedAtEpochMs)
    ) {
      cycleIntegrityValid = false;
    }
    if (index > 0) startGaps.push(finite(item?.startedAtEpochMs) - finite(cycles[index - 1]?.startedAtEpochMs));
    const shouldProbe = cycleNumber % API_SOAK_CSV_THRESHOLDS.failureEveryCycles === 0;
    const probe = item?.failureProbe;
    if (shouldProbe) {
      failureProbeCycles++;
      if (
        finite(probe?.duplicateConflict?.status) !== 409
        || probe?.duplicateConflict?.code !== "LARGE_CSV_NAME_CONFLICT"
        || finite(probe?.failedReplacement?.status) !== 400
        || probe?.failedReplacement?.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH"
        || finite(probe?.preservedSourceId) !== finite(item?.sourceId)
        || probe?.preservedSha256 !== item?.sha256
        || finite(probe?.preservedRows) !== API_SOAK_CSV_THRESHOLDS.rowsPerCycle
        || probe?.preservedLastRowNo !== "100000"
      ) recoveryValid = false;
    } else if (probe != null) {
      recoveryValid = false;
    }
    if (item?.deleted !== true || item?.sourceAbsent !== true) cleanupValid = false;
  }

  if (!cycleIntegrityValid || cycleNumbers.size !== API_SOAK_CSV_THRESHOLDS.expectedCycles || sourceIds.size !== cycles.length) {
    issues.push("one or more soak cycles lack exact upload integrity");
  }
  if (filenames.size !== API_SOAK_CSV_THRESHOLDS.rotatingFileSlots) issues.push("soak filename rotation is invalid");
  if (hashes.size !== cycles.length) issues.push("every soak cycle must use distinct deterministic content");
  if (
    failureProbeCycles !== API_SOAK_CSV_THRESHOLDS.expectedFailureProbeCycles
    || !recoveryValid
  ) issues.push("recurring failure recovery coverage is incomplete");
  if (!cleanupValid) issues.push("one or more soak cycles were not cleaned");

  const minimumGap = startGaps.length ? Math.min(...startGaps) : Number.NaN;
  const maximumGap = startGaps.length ? Math.max(...startGaps) : Number.NaN;
  if (
    minimumGap < API_SOAK_CSV_THRESHOLDS.minimumCycleGapMs
    || maximumGap > API_SOAK_CSV_THRESHOLDS.maximumCycleGapMs
  ) issues.push("cycle cadence is outside threshold");
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const latencyWindow = API_SOAK_CSV_THRESHOLDS.failureEveryCycles;
  const firstWindowP95 = percentile(latencies.slice(0, latencyWindow), 0.95);
  const lastWindowP95 = percentile(latencies.slice(-latencyWindow), 0.95);
  if (p95 > API_SOAK_CSV_THRESHOLDS.p95UploadSeconds) issues.push("soak p95 upload latency exceeds threshold");
  if (
    lastWindowP95 > Math.max(
      firstWindowP95 * API_SOAK_CSV_THRESHOLDS.latencyTrendMultiplier,
      API_SOAK_CSV_THRESHOLDS.latencyTrendFloorSeconds,
    )
  ) issues.push("last-window upload latency regressed beyond threshold");

  const summary = workload?.summary ?? {};
  if (finite(summary.unexpectedErrors) !== 0) issues.push("soak error budget must remain zero");
  if (
    finite(summary.successfulCycles) !== cycles.length
    || finite(summary.totalRows) !== totalRows
    || finite(summary.totalBytes) !== totalBytes
    || finite(summary.uniqueHashes) !== hashes.size
    || finite(summary.rotatingFileNames) !== filenames.size
    || finite(summary.failureProbeCycles) !== failureProbeCycles
    || !sameNumber(summary.minStartGapMs, minimumGap)
    || !sameNumber(summary.maxStartGapMs, maximumGap)
    || !sameNumber(summary.p50UploadSeconds, p50)
    || !sameNumber(summary.p95UploadSeconds, p95)
    || !sameNumber(summary.firstWindowP95Seconds, firstWindowP95)
    || !sameNumber(summary.lastWindowP95Seconds, lastWindowP95)
  ) issues.push("soak summary differs from cycle evidence");
  if (totalRows < API_SOAK_CSV_THRESHOLDS.minimumTotalRows) issues.push("total processed rows are below threshold");
  if (totalBytes < API_SOAK_CSV_THRESHOLDS.minimumTotalBytes) issues.push("total processed bytes are below threshold");
  if (
    workload?.cleanup?.sourcesAbsent !== true
    || finite(workload?.cleanup?.completedCycles) !== API_SOAK_CSV_THRESHOLDS.expectedCycles
  ) issues.push("workload cleanup is incomplete");

  const sampleIntervalMs = finite(observation?.environment?.sampleIntervalMs);
  if (sampleIntervalMs !== API_SOAK_CSV_THRESHOLDS.sampleIntervalMs) issues.push("resource sample interval contract is invalid");
  const samples = observation?.resourceSamples ?? {};
  const apiSamples = Array.isArray(samples.api) ? samples.api : [];
  const postgresSamples = Array.isArray(samples.postgres) ? samples.postgres : [];
  const clientSamples = Array.isArray(samples.client) ? samples.client : [];
  if ([apiSamples, postgresSamples, clientSamples].some((series) => series.length < API_SOAK_CSV_THRESHOLDS.minimumResourceSamples)) {
    issues.push("resource sample count is below threshold");
  }
  const apiMetrics = resourceMetrics(apiSamples, startedAtEpochMs, finishedAtEpochMs);
  const postgresMetrics = resourceMetrics(postgresSamples, startedAtEpochMs, finishedAtEpochMs);
  const clientMetrics = resourceMetrics(clientSamples, startedAtEpochMs, finishedAtEpochMs);
  if (![apiMetrics, postgresMetrics, clientMetrics].every((metrics) => metrics.cadenceValid && metrics.coverageValid)) {
    issues.push("resource sample cadence exceeds threshold");
  }
  if (!(apiMetrics.peak > 0) || apiMetrics.peak > API_SOAK_CSV_THRESHOLDS.apiPeakMemoryBytes) {
    issues.push("API peak memory exceeds threshold");
  }
  if (!(postgresMetrics.peak > 0) || postgresMetrics.peak > API_SOAK_CSV_THRESHOLDS.postgresPeakMemoryBytes) {
    issues.push("PostgreSQL peak memory exceeds threshold");
  }
  if (!(clientMetrics.peak > 0) || clientMetrics.peak > API_SOAK_CSV_THRESHOLDS.clientPeakWorkingSetBytes) {
    issues.push("client peak memory exceeds threshold");
  }
  if (apiMetrics.medianGrowth > API_SOAK_CSV_THRESHOLDS.apiMedianGrowthBytes) {
    issues.push("API median memory growth exceeds threshold");
  }
  if (!Number.isFinite(apiMetrics.medianGrowth)) {
    issues.push("API median memory growth is unavailable");
  }
  if (postgresMetrics.medianGrowth > API_SOAK_CSV_THRESHOLDS.postgresMedianGrowthBytes) {
    issues.push("PostgreSQL median memory growth exceeds threshold");
  }
  if (!Number.isFinite(postgresMetrics.medianGrowth)) {
    issues.push("PostgreSQL median memory growth is unavailable");
  }
  if (clientMetrics.medianGrowth > API_SOAK_CSV_THRESHOLDS.clientMedianGrowthBytes) {
    issues.push("client median memory growth exceeds threshold");
  }
  if (!Number.isFinite(clientMetrics.medianGrowth)) {
    issues.push("client median memory growth is unavailable");
  }

  const measured = observation?.observation ?? {};
  if (
    finite(measured.apiSamples) !== apiSamples.length
    || finite(measured.postgresSamples) !== postgresSamples.length
    || finite(measured.clientSamples) !== clientSamples.length
    || !sameNumber(measured.apiPeakMemoryBytes, apiMetrics.peak)
    || !sameNumber(measured.postgresPeakMemoryBytes, postgresMetrics.peak)
    || !sameNumber(measured.clientPeakWorkingSetBytes, clientMetrics.peak)
    || !sameNumber(measured.apiMedianGrowthBytes, apiMetrics.medianGrowth)
    || !sameNumber(measured.postgresMedianGrowthBytes, postgresMetrics.medianGrowth)
    || !sameNumber(measured.clientMedianGrowthBytes, clientMetrics.medianGrowth)
  ) issues.push("resource observation differs from raw samples");
  if (
    !(finite(measured.totalSeconds) >= API_SOAK_CSV_THRESHOLDS.minimumDurationSeconds)
    || finite(measured.totalSeconds) > API_SOAK_CSV_THRESHOLDS.maximumTotalSeconds
  ) issues.push("observer total duration is outside threshold");
  if (Math.abs(finite(measured.databaseGrowthBytes)) > API_SOAK_CSV_THRESHOLDS.databaseGrowthBytes) {
    issues.push("post-cleanup database growth exceeds threshold");
  }

  const residue = observation?.residue ?? {};
  if (finite(residue.sources) !== 0) issues.push("large CSV data source residue remains");
  if (finite(residue.tables) !== 0) issues.push("large CSV table residue remains");
  if (finite(residue.tempDirectories) !== 0) issues.push("large CSV temporary directory residue remains");

  const cleanup = evidence?.cleanup ?? {};
  if (finite(cleanup.containers) !== 0) issues.push("isolated containers remain after cleanup");
  if (finite(cleanup.volumes) !== 0) issues.push("isolated volumes remain after cleanup");
  if (finite(cleanup.networks) !== 0) issues.push("isolated networks remain after cleanup");
  if (finite(cleanup.imageTags) !== 0) issues.push("isolated image tag remains after cleanup");
  if (finite(cleanup.portListeners) !== 0) issues.push("isolated ports remain in use after cleanup");
  return [...new Set(issues)];
}
