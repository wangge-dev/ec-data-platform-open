export const API_MILLION_CSV_THRESHOLDS = Object.freeze({
  totalSeconds: 300,
  uploadSeconds: 240,
  repeatConflictSeconds: 10,
  failedReplacementSeconds: 30,
  apiPeakMemoryBytes: 1024 ** 3,
  postgresPeakMemoryBytes: 2 * 1024 ** 3,
  clientPeakWorkingSetBytes: 512 * 1024 ** 2,
  databaseGrowthBytes: 512 * 1024 ** 2,
  minimumSamples: 5,
  maximumSampleIntervalMs: 2_000,
});

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function validateApiMillionCsvEvidence(evidence: any): string[] {
  const issues: string[] = [];
  if (evidence?.schema !== "api-million-csv-upload-evidence/v2") issues.push("evidence schema is invalid");
  const provenance = evidence?.provenance ?? {};
  if (!/^[a-f0-9]{40}$/.test(String(provenance.sourceCommit ?? ""))) issues.push("sourceCommit is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(provenance.runtimeImageDigest ?? ""))) {
    issues.push("runtime image digest is invalid");
  }
  const observation = evidence?.observation;
  if (observation?.schema !== "api-million-csv-upload-observation/v2") issues.push("observation schema is invalid");
  if (observation?.provenance?.sourceCommit !== provenance.sourceCommit) {
    issues.push("observation sourceCommit differs from final evidence");
  }
  if (observation?.provenance?.runtimeImageDigest !== provenance.runtimeImageDigest) {
    issues.push("observation runtime image digest differs from final evidence");
  }
  const workload = observation?.workload;
  if (workload?.schema !== "api-million-csv-upload-result/v1") issues.push("workload schema is invalid");
  const boundary = workload?.boundary ?? {};
  if (boundary.transport !== "HTTP chunked raw text/csv") issues.push("transport must be HTTP chunked raw text/csv");
  if (finite(boundary.rows) !== 1_000_000) issues.push("workload must contain exactly 1000000 rows");
  if (boundary.ordinaryUploadCovered !== false) issues.push("evidence must not claim ordinary upload coverage");
  if (boundary.concurrencyCovered !== false) issues.push("evidence must not claim concurrency coverage");
  if (boundary.longDurationCovered !== false) issues.push("evidence must not claim long-duration coverage");
  if (boundary.realDataCovered !== false) issues.push("evidence must not claim real-data coverage");

  const upload = workload?.upload ?? {};
  if (finite(upload.rowCount) !== 1_000_000 || finite(upload.previewTotal) !== 1_000_000) {
    issues.push("upload and preview row counts must equal 1000000");
  }
  if (upload.firstRowNo !== "1" || upload.lastRowNo !== "1000000") issues.push("first/last row identity is invalid");
  if (upload.exceededOrdinary50MbLimit !== true || finite(upload.byteCount) <= 50 * 1024 * 1024) {
    issues.push("fixture must exceed the ordinary 50MB body limit");
  }
  if (!/^[a-f0-9]{64}$/.test(String(upload.sha256 ?? ""))) issues.push("upload SHA-256 is invalid");
  if (!(finite(upload.seconds) > 0 && finite(upload.seconds) <= API_MILLION_CSV_THRESHOLDS.uploadSeconds)) {
    issues.push("upload duration exceeds threshold");
  }

  const repeat = workload?.repeatConflict ?? {};
  if (finite(repeat.status) !== 409 || repeat.code !== "LARGE_CSV_NAME_CONFLICT") issues.push("repeat conflict evidence is invalid");
  if (!(finite(repeat.seconds) >= 0 && finite(repeat.seconds) <= API_MILLION_CSV_THRESHOLDS.repeatConflictSeconds)) {
    issues.push("repeat conflict duration exceeds threshold");
  }
  const recovery = workload?.failedReplacementRecovery ?? {};
  if (finite(recovery.status) !== 400 || recovery.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH") issues.push("failed replacement evidence is invalid");
  if (!(finite(recovery.seconds) >= 0 && finite(recovery.seconds) <= API_MILLION_CSV_THRESHOLDS.failedReplacementSeconds)) {
    issues.push("failed replacement duration exceeds threshold");
  }
  if (
    repeat.preservedSha256 !== upload.sha256
    || recovery.preservedSha256 !== upload.sha256
  ) issues.push("repeat/recovery hashes must equal upload hash");
  if (finite(recovery.preservedRows) !== 1_000_000 || recovery.preservedLastRowNo !== "1000000") {
    issues.push("failed replacement did not preserve exact rows");
  }
  if (workload?.cleanup?.deleted !== true || workload?.cleanup?.sourceAbsent !== true) issues.push("workload cleanup is incomplete");

  const metrics = observation?.observation ?? {};
  if (!(finite(metrics.totalSeconds) > 0 && finite(metrics.totalSeconds) <= API_MILLION_CSV_THRESHOLDS.totalSeconds)) {
    issues.push("total duration exceeds threshold");
  }
  if (finite(observation?.environment?.sampleIntervalMs) > API_MILLION_CSV_THRESHOLDS.maximumSampleIntervalMs) {
    issues.push("resource sample interval exceeds threshold");
  }
  if (finite(metrics.dockerSamples) < API_MILLION_CSV_THRESHOLDS.minimumSamples || finite(metrics.clientSamples) < API_MILLION_CSV_THRESHOLDS.minimumSamples) {
    issues.push("resource sample count is below threshold");
  }
  if (!(finite(metrics.apiPeakMemoryBytes) > 0) || finite(metrics.apiPeakMemoryBytes) > API_MILLION_CSV_THRESHOLDS.apiPeakMemoryBytes) {
    issues.push("API peak memory exceeds threshold");
  }
  if (!(finite(metrics.postgresPeakMemoryBytes) > 0) || finite(metrics.postgresPeakMemoryBytes) > API_MILLION_CSV_THRESHOLDS.postgresPeakMemoryBytes) {
    issues.push("PostgreSQL peak memory exceeds threshold");
  }
  if (!(finite(metrics.clientPeakWorkingSetBytes) > 0) || finite(metrics.clientPeakWorkingSetBytes) > API_MILLION_CSV_THRESHOLDS.clientPeakWorkingSetBytes) {
    issues.push("client peak memory exceeds threshold");
  }
  if (Math.abs(finite(metrics.databaseGrowthBytes)) > API_MILLION_CSV_THRESHOLDS.databaseGrowthBytes) {
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
  if (finite(cleanup.portListeners) !== 0) issues.push("isolated API port remains in use after cleanup");
  return [...new Set(issues)];
}
