import { sql as defaultSql } from "../db/client.js";
import { resolveExistingRuntimeTableReferenceFromSql } from "../db/table-scope.js";
import type { ColumnDef, ModuleDef } from "../modules/schema.js";
import {
  FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  isValidatedFrontProfitSourceConfig,
} from "./front-profit-standard.js";

export type SourceInspection = {
  sourceIds: number[];
  compatible: boolean;
  headers: string[];
  samples: Record<string, unknown>[];
  filenamePhrase: string | null;
  dataContract?: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION | null;
  statusValues: Array<{ value: string; rows: number }>;
  inferredTypes: Record<string, ColumnDef["type"]>;
  differences: Array<{ sourceId: number; added: string[]; missing: string[] }>;
};

export type SchemaDiff = {
  added: string[];
  missingRequired: string[];
  missingOptional: string[];
  missingRequiredFields?: Array<{
    name: string;
    label: string;
    compatibleSources: string[];
  }>;
  missingOptionalFields?: Array<{
    name: string;
    label: string;
    compatibleSources: string[];
  }>;
  aliasCandidates: Array<{ source: string; target: string; score: number }>;
  typeChanges: Array<{
    source: string;
    target: string;
    label: string;
    expected: ColumnDef["type"];
    required: boolean;
    blocking: boolean;
    compatibleSources: string[];
    failures: number;
    samples: string[];
  }>;
};

type InspectorRow = Record<string, unknown>;

export type InspectorSqlClient = {
  unsafe(
    query: string,
    parameters?: unknown[],
  ): PromiseLike<InspectorRow[]>;
};

export type InspectorDeps = {
  sql?: InspectorSqlClient;
  resolveTableReference?: (
    tableName: string,
    client: InspectorSqlClient,
  ) => Promise<string | null>;
};

export type InspectorOptions = {
  includeStatusValues?: boolean;
  statusSource?: string;
};

type StoredColumn = {
  raw: string;
  name: string;
};

type StoredSource = {
  id: number;
  type: string;
  config: {
    columns?: unknown;
    originalFileName?: unknown;
    frontProfitValidation?: { schemaVersion?: unknown };
  };
};

type InspectedSource = {
  id: number;
  columns: StoredColumn[];
  headers: string[];
  rows: InspectorRow[];
  fileName: string;
  dataContract: typeof FRONT_PROFIT_STANDARD_SCHEMA_VERSION | null;
  statusValues: Array<{ value: string; rows: number }>;
};

const TYPE_SAMPLE_LIMIT = 100;
const ROW_SAMPLE_LIMIT = 5;
const STATUS_VALUE_LIMIT = 20;
const TYPE_CONFIDENCE = 0.95;
const MAX_FIELD_NAME_CODEPOINTS = 256;
const MAX_ALIAS_SIMILARITY_COMPARISONS = 512;

function filenameTokens(fileName: string): string[] {
  const leaf = fileName.replaceAll("\\", "/").split("/").pop() ?? "";
  const withoutExtension = leaf.replace(/\.[^.]*$/, "");
  const withoutHash = withoutExtension.replace(/^[a-f0-9]{32}/i, "");
  const withDigitSeparators = withoutHash.replace(/\d+/g, " ");
  return withDigitSeparators
    .split(/[_\-\s]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => /^[a-z]+$/i.test(token));
}

function containsTokenSequence(tokens: string[], candidate: string[]): boolean {
  return tokens.some((_, index) =>
    candidate.every((token, offset) => tokens[index + offset] === token),
  );
}

export function deriveFilenamePhrase(fileNames: string[]): string | null {
  if (fileNames.length === 0) return null;
  const tokenSets = fileNames.map(filenameTokens);
  if (tokenSets.some((tokens) => tokens.length === 0)) return null;

  let common: string[] = [];
  const first = tokenSets[0];
  for (let start = 0; start < first.length; start += 1) {
    for (let end = start + 1; end <= first.length; end += 1) {
      const candidate = first.slice(start, end);
      const candidateLength = candidate.join("_").length;
      const commonLength = common.join("_").length;
      if (
        candidate.length < common.length ||
        (candidate.length === common.length && candidateLength <= commonLength)
      ) {
        continue;
      }
      if (
        tokenSets
          .slice(1)
          .every((tokens) => containsTokenSequence(tokens, candidate))
      ) {
        common = candidate;
      }
    }
  }

  const phrase = common.join("_");
  return phrase.length >= 4 ? phrase : null;
}

function nonEmptyValues(values: unknown[]): unknown[] {
  return values
    .filter(
      (value) =>
        value !== null &&
        value !== undefined &&
        (typeof value !== "string" || value.trim() !== ""),
    )
    .slice(0, TYPE_SAMPLE_LIMIT);
}

function normalizedNumber(value: unknown): string {
  return String(value).trim().replace(/,/g, "");
}

function isInteger(value: unknown): boolean {
  return /^[+-]?\d+$/.test(normalizedNumber(value));
}

function isNumeric(value: unknown): boolean {
  const normalized = normalizedNumber(value);
  return (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) &&
    Number.isFinite(Number(normalized))
  );
}

function isDate(value: unknown): boolean {
  const normalized = String(value).trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(normalized);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function isTimestamp(value: unknown): boolean {
  const normalized = String(value).trim();
  const numericDateMatch =
    /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})[T\s]\d{1,2}:\d{2}/.exec(normalized);
  if (numericDateMatch) {
    return (
      isDate(numericDateMatch[1]) &&
      !Number.isNaN(Date.parse(normalized))
    );
  }
  // XLSX date cells are stored as Date values and the PostgreSQL driver can
  // return their JavaScript string form when inspecting uploaded raw tables.
  const javascriptDate =
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT([+-])(\d{2})(\d{2})(?: \([^)]+\))?$/;
  const match = javascriptDate.exec(normalized);
  if (!match) return false;
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const month = monthNames.indexOf(match[2]) + 1;
  const day = Number(match[3]);
  const year = Number(match[4]);
  const hours = Number(match[5]);
  const minutes = Number(match[6]);
  const seconds = Number(match[7]);
  const offsetHours = Number(match[9]);
  const offsetMinutes = Number(match[10]);
  if (
    month === 0 ||
    !isDate(`${year}-${month}-${day}`) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59 ||
    weekdayNames[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
      !== match[1]
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(normalized));
}

function isBoolean(value: unknown): boolean {
  return [
    "true",
    "false",
    "1",
    "0",
    "y",
    "n",
    "yes",
    "no",
    "是",
    "否",
  ].includes(String(value).trim().toLowerCase());
}

function conversionRatio(
  values: unknown[],
  convert: (value: unknown) => boolean,
): number {
  if (values.length === 0) return 0;
  return values.filter(convert).length / values.length;
}

function inferType(values: unknown[]): ColumnDef["type"] {
  const sampled = nonEmptyValues(values);
  if (sampled.length === 0) return "text";

  if (conversionRatio(sampled, isInteger) >= TYPE_CONFIDENCE) return "int";
  if (conversionRatio(sampled, isNumeric) >= TYPE_CONFIDENCE) return "numeric";
  if (conversionRatio(sampled, isTimestamp) >= TYPE_CONFIDENCE) {
    return "timestamp";
  }
  if (conversionRatio(sampled, isDate) >= TYPE_CONFIDENCE) return "date";

  const hasTextualBoolean = sampled.some(
    (value) => !["0", "1"].includes(String(value).trim()),
  );
  if (
    hasTextualBoolean &&
    conversionRatio(sampled, isBoolean) >= TYPE_CONFIDENCE
  ) {
    return "boolean";
  }
  return "text";
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseColumns(sourceId: number, value: unknown): StoredColumn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`file source ${sourceId} has no column metadata`);
  }

  const columns = value.map((column, index) => {
    if (
      !column ||
      typeof column !== "object" ||
      typeof (column as { raw?: unknown }).raw !== "string" ||
      typeof (column as { name?: unknown }).name !== "string" ||
      !(column as { raw: string }).raw.trim() ||
      !(column as { name: string }).name.trim()
    ) {
      throw new Error(
        `file source ${sourceId} has invalid column metadata at index ${index}`,
      );
    }
    if (
      Array.from((column as { raw: string }).raw).length > MAX_FIELD_NAME_CODEPOINTS
      || Array.from((column as { name: string }).name).length > MAX_FIELD_NAME_CODEPOINTS
    ) {
      throw new Error(
        `file source ${sourceId} has overlong column metadata at index ${index}`,
      );
    }
    return {
      raw: (column as { raw: string }).raw,
      name: (column as { name: string }).name,
    };
  });

  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    throw new Error(`file source ${sourceId} has duplicate stored column names`);
  }
  return columns;
}

function remapRow(
  row: InspectorRow,
  columns: StoredColumn[],
): InspectorRow {
  return Object.fromEntries(
    columns.map((column) => [column.raw, row[column.name]]),
  );
}

function findStatusColumn(columns: StoredColumn[]): StoredColumn | undefined {
  return columns.find(
    (column) =>
      /status/i.test(column.name) || /(?:状态|狀態|status)/i.test(column.raw),
  );
}

async function inspectSource(
  source: StoredSource,
  client: InspectorSqlClient,
  resolveTableReference: NonNullable<InspectorDeps["resolveTableReference"]>,
  includeStatusValues: boolean,
  statusSource?: string,
): Promise<InspectedSource> {
  const columns = parseColumns(source.id, source.config.columns);
  const exactStatusColumn = statusSource
    ? columns.find((column) => column.raw === statusSource)
    : undefined;
  if (includeStatusValues && statusSource && !exactStatusColumn) {
    throw new Error(
      `statusSource must match a returned header: ${statusSource}`,
    );
  }
  const tableName = `uf_${source.id}`;
  const tableReference = await resolveTableReference(tableName, client);
  if (!tableReference) {
    throw new Error(`source table ${tableName} does not exist`);
  }

  const selectedColumns = columns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const storedRows = await client.unsafe(
    `SELECT ${selectedColumns} FROM ${tableReference} ORDER BY id LIMIT ${ROW_SAMPLE_LIMIT}`,
  );

  let statusValues: Array<{ value: string; rows: number }> = [];
  const statusColumn = includeStatusValues
    ? exactStatusColumn ?? findStatusColumn(columns)
    : undefined;
  if (includeStatusValues && statusColumn) {
    const statusIdentifier = quoteIdentifier(statusColumn.name);
    const groupedRows = await client.unsafe(
      `SELECT ${statusIdentifier} AS value, COUNT(*)::int AS rows ` +
        `FROM ${tableReference} ` +
        `WHERE ${statusIdentifier} IS NOT NULL AND BTRIM(${statusIdentifier}) <> '' ` +
        `GROUP BY ${statusIdentifier} ORDER BY rows DESC, value ` +
        `LIMIT ${STATUS_VALUE_LIMIT}`,
    );
    statusValues = groupedRows
      .slice(0, STATUS_VALUE_LIMIT)
      .map((row) => ({
        value: String(row.value),
        rows: Number(row.rows),
      }));
  }

  return {
    id: source.id,
    columns,
    headers: columns.map((column) => column.raw),
    rows: storedRows.map((row) => remapRow(row, columns)),
    fileName:
      typeof source.config.originalFileName === "string"
        ? source.config.originalFileName
        : "",
    dataContract:
      isValidatedFrontProfitSourceConfig(source.config)
        ? FRONT_PROFIT_STANDARD_SCHEMA_VERSION
        : null,
    statusValues,
  };
}

function headerDifferences(
  sources: InspectedSource[],
): SourceInspection["differences"] {
  if (sources.length < 2) return [];
  const baseline = sources[0].headers;
  const baselineSet = new Set(baseline);

  return sources.slice(1).flatMap((source) => {
    const sourceSet = new Set(source.headers);
    const added = source.headers.filter((header) => !baselineSet.has(header));
    const missing = baseline.filter((header) => !sourceSet.has(header));
    return added.length || missing.length
      ? [{ sourceId: source.id, added, missing }]
      : [];
  });
}

export async function inspectModuleSources(
  sourceIds: number[],
  deps?: InspectorDeps,
  options?: InspectorOptions,
): Promise<SourceInspection> {
  if (
    sourceIds.length === 0 ||
    sourceIds.some((sourceId) => !Number.isSafeInteger(sourceId) || sourceId <= 0)
  ) {
    throw new Error("sourceIds must contain at least one positive integer");
  }

  const client = deps?.sql ?? (defaultSql as unknown as InspectorSqlClient);
  const resolveTableReference =
    deps?.resolveTableReference ??
    (async (tableName: string, sqlClient: InspectorSqlClient) =>
      resolveExistingRuntimeTableReferenceFromSql(tableName, sqlClient));

  const sourceRows = (await client.unsafe(
    "SELECT id, type, config FROM public.data_sources WHERE id = ANY($1::bigint[])",
    [sourceIds],
  )) as StoredSource[];
  const sourcesById = new Map(
    sourceRows.map((source) => [Number(source.id), source]),
  );
  const orderedSources = sourceIds.map((sourceId) => {
    const source = sourcesById.get(sourceId);
    if (!source) throw new Error(`file source ${sourceId} does not exist`);
    return source;
  });

  for (const source of orderedSources) {
    if (source.type !== "file") {
      throw new Error(`source ${source.id} is not a file source`);
    }
  }

  const inspected: InspectedSource[] = [];
  for (const source of orderedSources) {
    inspected.push(
      await inspectSource(
        source,
        client,
        resolveTableReference,
        options?.includeStatusValues === true,
        options?.statusSource,
      ),
    );
  }

  const samples = inspected.flatMap((source) => source.rows);
  const headers = inspected[0].headers;
  const allHeaders = Array.from(
    new Set(inspected.flatMap((source) => source.headers)),
  );
  const inferredTypes = Object.fromEntries(
    allHeaders.map((header) => [
      header,
      inferType(samples.map((row) => row[header])),
    ]),
  ) as Record<string, ColumnDef["type"]>;

  const statusCounts = new Map<string, number>();
  for (const source of inspected) {
    for (const status of source.statusValues) {
      statusCounts.set(
        status.value,
        (statusCounts.get(status.value) ?? 0) + status.rows,
      );
    }
  }
  const statusValues = Array.from(statusCounts, ([value, rows]) => ({
    value,
    rows,
  }))
    .sort(
      (left, right) =>
        right.rows - left.rows || left.value.localeCompare(right.value),
    )
    .slice(0, STATUS_VALUE_LIMIT);
  const differences = headerDifferences(inspected);
  const dataContract = inspected.every(
    (source) => source.dataContract === FRONT_PROFIT_STANDARD_SCHEMA_VERSION,
  )
    ? FRONT_PROFIT_STANDARD_SCHEMA_VERSION
    : null;

  return {
    sourceIds: [...sourceIds],
    compatible: differences.length === 0,
    headers,
    samples,
    filenamePhrase: deriveFilenamePhrase(
      inspected.map((source) => source.fileName),
    ),
    dataContract,
    statusValues,
    inferredTypes,
    differences,
  };
}

function columnSources(module: ModuleDef, column: ColumnDef): string[] {
  const configured = [
    ...(Array.isArray(column.source)
      ? column.source
      : typeof column.source === "string"
        ? [column.source]
        : []),
    ...module.platforms.flatMap((platform) => {
      const override = platform.columnOverrides?.[column.name];
      return Array.isArray(override)
        ? override
        : typeof override === "string"
          ? [override]
          : [];
    }),
  ];
  return Array.from(new Set(configured));
}

function normalizedFieldName(value: string): string[] {
  return Array.from(
    value.normalize("NFKC").toLowerCase().replace(/[\s_\-()[\]{}]+/g, ""),
  );
}

function editDistance(left: string[], right: string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function fieldSimilarity(left: string, right: string): number {
  if (
    Array.from(left).length > MAX_FIELD_NAME_CODEPOINTS
    || Array.from(right).length > MAX_FIELD_NAME_CODEPOINTS
  ) {
    return 0;
  }
  const normalizedLeft = normalizedFieldName(left);
  const normalizedRight = normalizedFieldName(right);
  if (
    normalizedLeft.length > MAX_FIELD_NAME_CODEPOINTS
    || normalizedRight.length > MAX_FIELD_NAME_CODEPOINTS
  ) {
    return 0;
  }
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  if (length === 0) return 0;
  return Number(
    (1 - editDistance(normalizedLeft, normalizedRight) / length).toFixed(3),
  );
}

function preferredSource(column: ColumnDef, sources: string[]): string {
  if (typeof column.source === "string") return column.source;
  if (Array.isArray(column.source) && column.source.length > 0) {
    return column.source[0];
  }
  return sources[0] ?? column.label ?? column.name;
}

function convertsTo(
  value: unknown,
  expected: ColumnDef["type"],
): boolean {
  switch (expected) {
    case "int":
      return isInteger(value);
    case "numeric":
      return isNumeric(value);
    case "timestamp":
      return isTimestamp(value) || isDate(value);
    case "date":
      return isDate(value);
    case "boolean":
      return isBoolean(value);
    case "text":
      return true;
  }
}

function inferredTypeFits(
  inferred: ColumnDef["type"],
  expected: ColumnDef["type"],
): boolean {
  if (expected === "text") return true;
  if (expected === "numeric") return inferred === "numeric" || inferred === "int";
  if (expected === "timestamp") {
    return inferred === "timestamp" || inferred === "date";
  }
  return inferred === expected;
}

export function diffModuleSchema(
  module: ModuleDef,
  inspection: SourceInspection,
): SchemaDiff {
  const headers = new Set(inspection.headers);
  const expectedColumns = module.columns
    .filter((column) => !column.computed)
    .map((column) => {
      const sources = columnSources(module, column);
      return {
        column,
        sources,
        matchedSource: sources.find((source) => headers.has(source)),
        displaySource: preferredSource(column, sources),
      };
    });
  const recognizedSources = new Set(
    expectedColumns.flatMap((expected) => expected.sources),
  );
  const added = inspection.headers.filter(
    (header) => !recognizedSources.has(header),
  );
  const missing = expectedColumns.filter(
    (expected) => !expected.matchedSource,
  );
  const missingRequired = missing
    .filter(({ column }) => column.required)
    .map(({ displaySource }) => displaySource);
  const missingOptional = missing
    .filter(({ column }) => !column.required)
    .map(({ displaySource }) => displaySource);

  const comparisonsPerAdded = missing.reduce(
    (total, expected) => total + expected.sources.length,
    0,
  );
  const similarityComparisons = comparisonsPerAdded * added.length;
  const aliasCandidates = Number.isSafeInteger(similarityComparisons)
    && similarityComparisons <= MAX_ALIAS_SIMILARITY_COMPARISONS
    ? added
      .flatMap((source) =>
        missing.flatMap(({ column, sources }) => {
          const score = Math.max(
            ...sources.map((target) => fieldSimilarity(source, target)),
            0,
          );
          return score >= 0.5
            ? [{ source, target: column.name, score }]
            : [];
        }),
      )
      .sort(
        (left, right) =>
          right.score - left.score || left.source.localeCompare(right.source),
      )
    : [];

  const typeChanges = expectedColumns.flatMap(
    ({ column, matchedSource }) => {
      if (!matchedSource) return [];
      const inferred = inspection.inferredTypes[matchedSource] ?? "text";
      if (inferredTypeFits(inferred, column.type)) return [];

      const values = nonEmptyValues(
        inspection.samples.map((sample) => sample[matchedSource]),
      );
      const failed = values.filter(
        (value) => !convertsTo(value, column.type),
      );
      if (failed.length === 0) return [];
      return [
        {
          source: matchedSource,
          target: column.name,
          label: column.label ?? preferredSource(column, [matchedSource]),
          expected: column.type,
          required: column.required,
          blocking: column.required || column.semanticRole !== undefined,
          compatibleSources: added.filter((source) =>
            inferredTypeFits(
              inspection.inferredTypes[source] ?? "text",
              column.type,
            ),
          ),
          failures: failed.length,
          samples: Array.from(new Set(failed.map(String))).slice(0, 5),
        },
      ];
    },
  );

  return {
    added,
    missingRequired,
    missingOptional,
    missingRequiredFields: missing
      .filter(({ column }) => column.required)
      .map(({ column, displaySource }) => ({
        name: column.name,
        label: column.label ?? displaySource,
        compatibleSources: added.filter((source) =>
          inferredTypeFits(
            inspection.inferredTypes[source] ?? "text",
            column.type,
          ),
        ),
      })),
    missingOptionalFields: missing
      .filter(({ column }) => !column.required)
      .map(({ column, displaySource }) => ({
        name: column.name,
        label: column.label ?? displaySource,
        compatibleSources: added.filter((source) =>
          inferredTypeFits(
            inspection.inferredTypes[source] ?? "text",
            column.type,
          ),
        ),
      })),
    aliasCandidates,
    typeChanges,
  };
}
