export const API_CONCURRENT_CSV_THRESHOLDS = Object.freeze({
  totalSeconds: 300,
  successWaveSeconds: 180,
  perSuccessUploadSeconds: 180,
  mixedWaveSeconds: 60,
  successConcurrency: 3,
  rowsPerSuccessUpload: 500_000,
  mixedFreshUploadRows: 100_000,
  minimumSuccessOverlapMs: 1_000,
  minimumMixedOverlapMs: 1,
  apiPeakMemoryBytes: 2 * 1024 ** 3,
  postgresPeakMemoryBytes: 4 * 1024 ** 3,
  clientPeakWorkingSetBytes: 1024 ** 3,
  databaseGrowthBytes: 512 * 1024 ** 2,
  minimumSamples: 5,
  maximumSampleIntervalMs: 2_000,
});

const ORDINARY_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function exactOverlapMs(operations: any[]): number {
  if (!Array.isArray(operations) || operations.length === 0) return Number.NaN;
  const starts = operations.map((operation) => finite(operation?.startedAtEpochMs));
  const finishes = operations.map((operation) => finite(operation?.finishedAtEpochMs));
  if ([...starts, ...finishes].some((value) => !Number.isSafeInteger(value))) return Number.NaN;
  if (operations.some((_, index) => finishes[index] <= starts[index])) return Number.NaN;
  return Math.max(0, Math.min(...finishes) - Math.max(...starts));
}

function isSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value ?? ""));
}

function validateUploadIntegrity(upload: any, rows: number, requireOver50Mb: boolean): string[] {
  const issues: string[] = [];
  if (finite(upload?.status) !== 200) issues.push("success upload status is invalid");
  if (
    finite(upload?.rowCount) !== rows
    || finite(upload?.previewTotal) !== rows
    || upload?.firstRowNo !== "1"
    || upload?.lastRowNo !== String(rows)
  ) {
    issues.push("every success upload must preserve exact row identity");
  }
  if (!isSha256(upload?.sha256) || upload?.serverSha256 !== upload?.sha256) {
    issues.push("success upload client/server SHA-256 is invalid");
  }
  if (!(finite(upload?.byteCount) > 0) || finite(upload?.serverByteCount) !== finite(upload?.byteCount)) {
    issues.push("success upload client/server byte count is invalid");
  }
  if (requireOver50Mb && (upload?.exceededOrdinary50MbLimit !== true || finite(upload?.byteCount) <= ORDINARY_BODY_LIMIT_BYTES)) {
    issues.push("every success fixture must exceed the ordinary 50MB limit");
  }
  if (
    !(finite(upload?.seconds) > 0)
    || finite(upload?.seconds) > API_CONCURRENT_CSV_THRESHOLDS.perSuccessUploadSeconds
  ) {
    issues.push("success upload duration exceeds threshold");
  }
  if (!Number.isSafeInteger(finite(upload?.sourceId)) || finite(upload?.sourceId) <= 0) {
    issues.push("success upload source identity is invalid");
  }
  return issues;
}

export function validateApiConcurrentCsvEvidence(evidence: any): string[] {
  const issues: string[] = [];
  if (evidence?.schema !== "api-concurrent-csv-upload-evidence/v1") issues.push("evidence schema is invalid");
  const provenance = evidence?.provenance ?? {};
  if (!/^[a-f0-9]{40}$/.test(String(provenance.sourceCommit ?? ""))) issues.push("sourceCommit is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(provenance.runtimeImageDigest ?? ""))) {
    issues.push("runtime image digest is invalid");
  }

  const observation = evidence?.observation;
  if (observation?.schema !== "api-concurrent-csv-upload-observation/v1") issues.push("observation schema is invalid");
  if (observation?.provenance?.sourceCommit !== provenance.sourceCommit) {
    issues.push("observation sourceCommit differs from final evidence");
  }
  if (observation?.provenance?.runtimeImageDigest !== provenance.runtimeImageDigest) {
    issues.push("observation runtime image digest differs from final evidence");
  }

  const workload = observation?.workload;
  if (workload?.schema !== "api-concurrent-csv-upload-result/v1") issues.push("workload schema is invalid");
  const boundary = workload?.boundary ?? {};
  if (boundary.transport !== "HTTP chunked raw text/csv") issues.push("transport must be HTTP chunked raw text/csv");
  if (finite(boundary.successConcurrency) !== API_CONCURRENT_CSV_THRESHOLDS.successConcurrency) {
    issues.push("success concurrency must equal 3");
  }
  if (finite(boundary.rowsPerSuccessUpload) !== API_CONCURRENT_CSV_THRESHOLDS.rowsPerSuccessUpload) {
    issues.push("rows per success upload must equal 500000");
  }
  if (finite(boundary.successTotalRows) !== 1_500_000) issues.push("success wave must contain exactly 1500000 rows");
  if (finite(boundary.mixedFreshUploadRows) !== API_CONCURRENT_CSV_THRESHOLDS.mixedFreshUploadRows) {
    issues.push("mixed fresh upload must contain exactly 100000 rows");
  }
  if (boundary.ordinaryUploadCovered !== false) issues.push("evidence must not claim ordinary upload coverage");
  if (boundary.concurrencyCovered !== true) issues.push("evidence must claim only the measured concurrency coverage");
  if (boundary.longDurationCovered !== false) issues.push("evidence must not claim long-duration coverage");
  if (boundary.realDataCovered !== false) issues.push("evidence must not claim real-data coverage");
  if (boundary.productionSlaCovered !== false) issues.push("evidence must not claim production SLA coverage");

  const successWave = workload?.successWave ?? {};
  const uploads = Array.isArray(successWave.uploads) ? successWave.uploads : [];
  if (uploads.length !== API_CONCURRENT_CSV_THRESHOLDS.successConcurrency) {
    issues.push("success wave must contain exactly 3 uploads");
  }
  uploads.forEach((upload: any) => {
    issues.push(...validateUploadIntegrity(upload, API_CONCURRENT_CSV_THRESHOLDS.rowsPerSuccessUpload, true));
  });
  const successSlots = new Set(uploads.map((upload: any) => finite(upload?.slot)));
  const successFiles = new Set(uploads.map((upload: any) => String(upload?.fileName ?? "")));
  const successSources = new Set(uploads.map((upload: any) => finite(upload?.sourceId)));
  const successHashes = new Set(uploads.map((upload: any) => String(upload?.sha256 ?? "")));
  if (successSlots.size !== 3 || ![1, 2, 3].every((slot) => successSlots.has(slot))) issues.push("success upload slots must be exactly 1, 2, and 3");
  if (successFiles.size !== 3 || [...successFiles].some((fileName) => !fileName.endsWith(".csv"))) issues.push("success upload filenames must be distinct CSV names");
  if (successSources.size !== 3) issues.push("success upload source IDs must be distinct");
  if (successHashes.size !== 3) issues.push("success upload hashes must be distinct");
  if (!(finite(successWave.seconds) > 0) || finite(successWave.seconds) > API_CONCURRENT_CSV_THRESHOLDS.successWaveSeconds) {
    issues.push("success wave duration exceeds threshold");
  }
  const calculatedSuccessOverlap = exactOverlapMs(uploads);
  if (finite(successWave.overlapMs) !== calculatedSuccessOverlap) issues.push("success upload overlap does not match operation intervals");
  if (!(calculatedSuccessOverlap >= API_CONCURRENT_CSV_THRESHOLDS.minimumSuccessOverlapMs)) {
    issues.push("success upload overlap is below threshold");
  }

  const mixedWave = workload?.mixedWave ?? {};
  if (!(finite(mixedWave.seconds) > 0) || finite(mixedWave.seconds) > API_CONCURRENT_CSV_THRESHOLDS.mixedWaveSeconds) {
    issues.push("mixed wave duration exceeds threshold");
  }
  const replacement = mixedWave.failedReplacement ?? {};
  const duplicate = mixedWave.duplicateConflict ?? {};
  const fresh = mixedWave.freshUpload ?? {};
  const mixedOperations = [replacement, duplicate, fresh];
  const calculatedMixedOverlap = exactOverlapMs(mixedOperations);
  if (finite(mixedWave.overlapMs) !== calculatedMixedOverlap) issues.push("mixed operation overlap does not match operation intervals");
  if (!(calculatedMixedOverlap >= API_CONCURRENT_CSV_THRESHOLDS.minimumMixedOverlapMs)) {
    issues.push("mixed operation overlap is missing");
  }
  if (finite(replacement.status) !== 400 || replacement.code !== "LARGE_CSV_EXPECTED_ROWS_MISMATCH") {
    issues.push("failed replacement evidence is invalid");
  }
  if (finite(duplicate.status) !== 409 || duplicate.code !== "LARGE_CSV_NAME_CONFLICT") {
    issues.push("duplicate conflict evidence is invalid");
  }
  if (
    finite(replacement.targetSourceId) !== finite(uploads[0]?.sourceId)
    || finite(replacement.preservedSourceId) !== finite(uploads[0]?.sourceId)
    || replacement.preservedSha256 !== uploads[0]?.sha256
    || finite(replacement.preservedRows) !== API_CONCURRENT_CSV_THRESHOLDS.rowsPerSuccessUpload
    || replacement.preservedLastRowNo !== "500000"
    || finite(duplicate.targetSourceId) !== finite(uploads[1]?.sourceId)
    || finite(duplicate.preservedSourceId) !== finite(uploads[1]?.sourceId)
    || duplicate.preservedSha256 !== uploads[1]?.sha256
    || finite(duplicate.preservedRows) !== API_CONCURRENT_CSV_THRESHOLDS.rowsPerSuccessUpload
    || duplicate.preservedLastRowNo !== "500000"
  ) {
    issues.push("mixed failures did not preserve their target uploads");
  }
  const freshIssues = validateUploadIntegrity(fresh, API_CONCURRENT_CSV_THRESHOLDS.mixedFreshUploadRows, false);
  if (freshIssues.length) issues.push("fresh mixed-wave upload integrity is invalid");
  if (successFiles.has(String(fresh.fileName ?? "")) || successSources.has(finite(fresh.sourceId)) || successHashes.has(String(fresh.sha256 ?? ""))) {
    issues.push("fresh mixed-wave upload is not distinct");
  }

  const cleanup = workload?.cleanup ?? {};
  const deletedSourceIds = Array.isArray(cleanup.deletedSourceIds) ? cleanup.deletedSourceIds.map(finite) : [];
  const expectedSourceIds = [...uploads.map((upload: any) => finite(upload?.sourceId)), finite(fresh.sourceId)];
  if (
    finite(cleanup.expectedDeletedSources) !== 4
    || deletedSourceIds.length !== 4
    || new Set(deletedSourceIds).size !== 4
    || !expectedSourceIds.every((sourceId) => deletedSourceIds.includes(sourceId))
    || cleanup.sourceNamesAbsent !== true
  ) {
    issues.push("workload cleanup is incomplete");
  }

  const metrics = observation?.observation ?? {};
  if (!(finite(metrics.totalSeconds) > 0) || finite(metrics.totalSeconds) > API_CONCURRENT_CSV_THRESHOLDS.totalSeconds) {
    issues.push("total duration exceeds threshold");
  }
  if (finite(observation?.environment?.sampleIntervalMs) > API_CONCURRENT_CSV_THRESHOLDS.maximumSampleIntervalMs) {
    issues.push("resource sample interval exceeds threshold");
  }
  if (
    finite(metrics.dockerSamples) < API_CONCURRENT_CSV_THRESHOLDS.minimumSamples
    || finite(metrics.clientSamples) < API_CONCURRENT_CSV_THRESHOLDS.minimumSamples
  ) {
    issues.push("resource sample count is below threshold");
  }
  if (!(finite(metrics.apiPeakMemoryBytes) > 0) || finite(metrics.apiPeakMemoryBytes) > API_CONCURRENT_CSV_THRESHOLDS.apiPeakMemoryBytes) {
    issues.push("API peak memory exceeds threshold");
  }
  if (!(finite(metrics.postgresPeakMemoryBytes) > 0) || finite(metrics.postgresPeakMemoryBytes) > API_CONCURRENT_CSV_THRESHOLDS.postgresPeakMemoryBytes) {
    issues.push("PostgreSQL peak memory exceeds threshold");
  }
  if (!(finite(metrics.clientPeakWorkingSetBytes) > 0) || finite(metrics.clientPeakWorkingSetBytes) > API_CONCURRENT_CSV_THRESHOLDS.clientPeakWorkingSetBytes) {
    issues.push("client peak memory exceeds threshold");
  }
  if (Math.abs(finite(metrics.databaseGrowthBytes)) > API_CONCURRENT_CSV_THRESHOLDS.databaseGrowthBytes) {
    issues.push("post-cleanup database growth exceeds threshold");
  }

  const residue = observation?.residue ?? {};
  if (finite(residue.sources) !== 0) issues.push("large CSV data source residue remains");
  if (finite(residue.tables) !== 0) issues.push("large CSV table residue remains");
  if (finite(residue.tempDirectories) !== 0) issues.push("large CSV temporary directory residue remains");

  const projectCleanup = evidence?.cleanup ?? {};
  if (finite(projectCleanup.containers) !== 0) issues.push("isolated containers remain after cleanup");
  if (finite(projectCleanup.volumes) !== 0) issues.push("isolated volumes remain after cleanup");
  if (finite(projectCleanup.networks) !== 0) issues.push("isolated networks remain after cleanup");
  if (finite(projectCleanup.imageTags) !== 0) issues.push("isolated image tag remains after cleanup");
  if (finite(projectCleanup.portListeners) !== 0) issues.push("isolated ports remain in use after cleanup");
  return [...new Set(issues)];
}
