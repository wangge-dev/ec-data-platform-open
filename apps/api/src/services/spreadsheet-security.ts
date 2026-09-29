import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { Worker } from "node:worker_threads";

export const SPREADSHEET_LIMITS = Object.freeze({
  maxInputBytes: 30 * 1024 * 1024,
  maxArchiveEntries: 1024,
  maxArchiveUncompressedBytes: 96 * 1024 * 1024,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 200,
  compressionRatioMinBytes: 1024 * 1024,
  maxSheets: 64,
  maxWorksheetRows: 100_010,
  maxWorksheetColumns: 1024,
  maxWorksheetCells: 2_000_000,
  maxCellTextBytes: 128 * 1024,
  maxReturnedBytes: 64 * 1024 * 1024,
  parseTimeoutMs: 30_000,
  workerMaxOldGenerationMb: 256,
  maxConcurrentParsers: 2,
  maxQueuedParsers: 4,
  maxParserQueueWaitMs: 10_000,
});

export type SpreadsheetSecurityCode =
  | "SPREADSHEET_TOO_LARGE"
  | "INVALID_SPREADSHEET_CONTAINER"
  | "UNSAFE_ZIP_STRUCTURE"
  | "ZIP_RESOURCE_LIMIT"
  | "EXTERNAL_RELATIONSHIP"
  | "ACTIVE_CONTENT"
  | "WORKSHEET_RESOURCE_LIMIT"
  | "CELL_RESOURCE_LIMIT"
  | "SPREADSHEET_RESULT_LIMIT"
  | "SPREADSHEET_BUSY"
  | "SPREADSHEET_PARSE_TIMEOUT"
  | "SPREADSHEET_PARSE_FAILED";

export class SpreadsheetSecurityError extends Error {
  constructor(
    public readonly code: SpreadsheetSecurityCode,
    message: string,
  ) {
    super(message);
    this.name = "SpreadsheetSecurityError";
  }
}

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
};

export type SpreadsheetRows = {
  sheetName: string;
  rows: unknown[][];
};

export type SpreadsheetParseOptions = {
  sheetName?: string;
};

const require = createRequire(import.meta.url);
const XLSX_MODULE_PATH = require.resolve("xlsx");
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const MIN_EOCD_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function fail(code: SpreadsheetSecurityCode, message: string): never {
  throw new SpreadsheetSecurityError(code, message);
}

function readUInt16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 目录已截断");
  }
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 目录已截断");
  }
  return bytes.readUInt32LE(offset);
}

function calculateCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertSafeZipExtra(bytes: Buffer, start: number, length: number): void {
  const end = start + length;
  if (start < 0 || end < start || end > bytes.length) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP extra field is truncated");
  }
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP extra field is malformed");
    }
    const identifier = readUInt16(bytes, offset);
    const valueLength = readUInt16(bytes, offset + 2);
    const nextOffset = offset + 4 + valueLength;
    if (nextOffset > end) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP extra field is malformed");
    }
    // These extensions can override sizes, encryption or the entry name seen by
    // different ZIP parsers.  Rejecting them removes parser differentials.
    if (identifier === 0x0001 || identifier === 0x9901 || identifier === 0x7075) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP contains an unsupported metadata extension");
    }
    offset = nextOffset;
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const lowerBound = Math.max(0, bytes.length - MIN_EOCD_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let offset = bytes.length - MIN_EOCD_BYTES; offset >= lowerBound; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const commentLength = readUInt16(bytes, offset + 20);
    if (offset + MIN_EOCD_BYTES + commentLength === bytes.length) return offset;
  }
  return fail("UNSAFE_ZIP_STRUCTURE", "XLSX 缺少完整的 ZIP 中央目录");
}

function decodeZipName(raw: Buffer): string {
  const name = raw.toString("utf8");
  if (
    !name
    || name.includes("\uFFFD")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[a-z]:/i.test(name)
    || name.includes("\0")
    || name.split("/").some((part, index, parts) => (
      part === "."
      || part === ".."
      || (part === "" && index !== parts.length - 1)
    ))
    || /[\u0000-\u001f\u007f]/.test(name)
  ) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 包含非法条目名称");
  }
  return name;
}

function parseZipEntries(bytes: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readUInt16(bytes, eocdOffset + 4);
  const centralDisk = readUInt16(bytes, eocdOffset + 6);
  const entriesOnDisk = readUInt16(bytes, eocdOffset + 8);
  const entryCount = readUInt16(bytes, eocdOffset + 10);
  const centralSize = readUInt32(bytes, eocdOffset + 12);
  const centralOffset = readUInt32(bytes, eocdOffset + 16);

  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    fail("UNSAFE_ZIP_STRUCTURE", "不支持分卷或 ZIP64 XLSX");
  }
  if (entryCount === 0 || entryCount > SPREADSHEET_LIMITS.maxArchiveEntries) {
    fail(
      "ZIP_RESOURCE_LIMIT",
      `XLSX ZIP 条目数超过上限 ${SPREADSHEET_LIMITS.maxArchiveEntries}`,
    );
  }
  const centralEnd = centralOffset + centralSize;
  if (
    centralOffset < 0
    || centralEnd < centralOffset
    || centralEnd !== eocdOffset
  ) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 中央目录边界无效");
  }

  const entries: ZipEntry[] = [];
  const localRanges: Array<{ start: number; end: number }> = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(bytes, offset) !== ZIP_CENTRAL_FILE) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 中央目录条目无效");
    }
    const flags = readUInt16(bytes, offset + 8);
    const method = readUInt16(bytes, offset + 10);
    const expectedCrc32 = readUInt32(bytes, offset + 16);
    const compressedSize = readUInt32(bytes, offset + 20);
    const uncompressedSize = readUInt32(bytes, offset + 24);
    const nameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const diskStart = readUInt16(bytes, offset + 34);
    const localOffset = readUInt32(bytes, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const extraStart = nameEnd;
    const commentStart = extraStart + extraLength;
    const nextOffset = commentStart + commentLength;
    if (nextOffset > centralEnd || diskStart !== 0) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 中央目录条目越界");
    }
    assertSafeZipExtra(bytes, extraStart, extraLength);
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
    ) {
      fail("UNSAFE_ZIP_STRUCTURE", "不支持 ZIP64 XLSX 条目");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail("UNSAFE_ZIP_STRUCTURE", "不支持加密 XLSX 条目");
    }
    if (method !== 0 && method !== 8) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 使用了不支持的压缩算法");
    }
    const allowedFlags = method === 8 ? 0x080e : 0x0808;
    if ((flags & ~allowedFlags) !== 0) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 使用了不支持的通用标志");
    }
    const name = decodeZipName(bytes.subarray(nameStart, nameEnd));
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 包含重复条目");
    }
    names.add(normalizedName);

    if (uncompressedSize > SPREADSHEET_LIMITS.maxEntryUncompressedBytes) {
      fail(
        "ZIP_RESOURCE_LIMIT",
        `XLSX ZIP 单条目解压大小超过上限 ${SPREADSHEET_LIMITS.maxEntryUncompressedBytes}`,
      );
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      fail("ZIP_RESOURCE_LIMIT", "XLSX ZIP 条目压缩比无效");
    }
    if (
      uncompressedSize >= SPREADSHEET_LIMITS.compressionRatioMinBytes
      && uncompressedSize / compressedSize > SPREADSHEET_LIMITS.maxCompressionRatio
    ) {
      fail(
        "ZIP_RESOURCE_LIMIT",
        `XLSX ZIP 条目压缩比超过上限 ${SPREADSHEET_LIMITS.maxCompressionRatio}:1`,
      );
    }

    if (readUInt32(bytes, localOffset) !== ZIP_LOCAL_FILE) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 本地条目无效");
    }
    const localFlags = readUInt16(bytes, localOffset + 6);
    const localMethod = readUInt16(bytes, localOffset + 8);
    const localCrc32 = readUInt32(bytes, localOffset + 14);
    const localCompressedSize = readUInt32(bytes, localOffset + 18);
    const localUncompressedSize = readUInt32(bytes, localOffset + 22);
    const localNameLength = readUInt16(bytes, localOffset + 26);
    const localExtraLength = readUInt16(bytes, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const localExtraStart = localNameEnd;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags
      || localMethod !== method
      || localNameEnd > centralOffset
      || dataStart < localOffset
      || dataEnd < dataStart
      || dataEnd > centralOffset
      || decodeZipName(bytes.subarray(localNameStart, localNameEnd)) !== name
    ) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 本地条目与中央目录不一致");
    }
    assertSafeZipExtra(bytes, localExtraStart, localExtraLength);

    let recordEnd = dataEnd;
    if ((flags & 0x0008) === 0) {
      if (
        localCrc32 !== expectedCrc32
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize
      ) {
        fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 本地大小或 CRC 与中央目录不一致");
      }
    } else {
      if (
        (localCrc32 !== 0 && localCrc32 !== expectedCrc32)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
      ) {
        fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 本地数据描述符占位值不一致");
      }
      const descriptorMatches = (valueOffset: number): boolean => (
        valueOffset >= dataEnd
        && valueOffset + 12 <= centralOffset
        && readUInt32(bytes, valueOffset) === expectedCrc32
        && readUInt32(bytes, valueOffset + 4) === compressedSize
        && readUInt32(bytes, valueOffset + 8) === uncompressedSize
      );
      if (
        dataEnd + 16 <= centralOffset
        && readUInt32(bytes, dataEnd) === ZIP_DATA_DESCRIPTOR
        && descriptorMatches(dataEnd + 4)
      ) {
        recordEnd = dataEnd + 16;
      } else if (descriptorMatches(dataEnd)) {
        recordEnd = dataEnd + 12;
      } else {
        fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 数据描述符缺失或不一致");
      }
    }

    entries.push({
      name,
      flags,
      method,
      crc32: expectedCrc32,
      compressedSize,
      uncompressedSize,
      dataStart,
    });
    localRanges.push({ start: localOffset, end: recordEnd });
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (
      !Number.isSafeInteger(totalUncompressed)
      || totalUncompressed > SPREADSHEET_LIMITS.maxArchiveUncompressedBytes
    ) {
      fail(
        "ZIP_RESOURCE_LIMIT",
        `XLSX ZIP 总解压大小超过上限 ${SPREADSHEET_LIMITS.maxArchiveUncompressedBytes}`,
      );
    }
    offset = nextOffset;
  }
  if (offset !== centralEnd) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 中央目录包含未声明数据");
  }
  localRanges.sort((left, right) => left.start - right.start);
  let expectedLocalOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedLocalOffset || range.end <= range.start) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 本地记录重叠或包含未声明间隙");
    }
    expectedLocalOffset = range.end;
  }
  if (expectedLocalOffset !== centralOffset) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 中央目录前包含未声明数据");
  }
  if (
    totalUncompressed >= SPREADSHEET_LIMITS.compressionRatioMinBytes
    && (totalCompressed === 0
      || totalUncompressed / totalCompressed > SPREADSHEET_LIMITS.maxCompressionRatio)
  ) {
    fail(
      "ZIP_RESOURCE_LIMIT",
      `XLSX ZIP 总压缩比超过上限 ${SPREADSHEET_LIMITS.maxCompressionRatio}:1`,
    );
  }
  return entries;
}

function inflateZipEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let inflated: Buffer;
  try {
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 未压缩条目大小不一致");
      }
      inflated = Buffer.from(compressed);
    } else {
      inflated = inflateRawSync(compressed, {
        maxOutputLength: Math.min(
          SPREADSHEET_LIMITS.maxEntryUncompressedBytes + 1,
          entry.uncompressedSize + 1,
        ),
      });
    }
  } catch (error) {
    if (error instanceof SpreadsheetSecurityError) throw error;
    return fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 条目无法安全解压");
  }
  if (inflated.length !== entry.uncompressedSize) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 条目声明大小与实际不一致");
  }
  if (calculateCrc32(inflated) !== entry.crc32) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP 条目 CRC 校验失败");
  }
  return inflated;
}

function columnNumber(column: string): number {
  let value = 0;
  for (const character of column.toUpperCase()) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    value = value * 26 + code - 64;
  }
  return value;
}

function assertCellCoordinate(column: string, rowText: string): void {
  const columnIndex = columnNumber(column);
  const rowIndex = Number(rowText);
  if (
    columnIndex < 1
    || columnIndex > SPREADSHEET_LIMITS.maxWorksheetColumns
    || !Number.isSafeInteger(rowIndex)
    || rowIndex < 1
    || rowIndex > SPREADSHEET_LIMITS.maxWorksheetRows
  ) {
    fail("WORKSHEET_RESOURCE_LIMIT", "XLSX 工作表坐标超过安全上限");
  }
}

function assertWorksheetRange(reference: string): void {
  const normalized = reference.replaceAll("$", "").trim();
  const match = /^([A-Za-z]{1,4})([0-9]+)(?::([A-Za-z]{1,4})([0-9]+))?$/.exec(normalized);
  if (!match) {
    fail("WORKSHEET_RESOURCE_LIMIT", "XLSX 工作表范围无效");
  }
  const startColumn = columnNumber(match[1]);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3] ?? match[1]);
  const endRow = Number(match[4] ?? match[2]);
  assertCellCoordinate(match[1], match[2]);
  assertCellCoordinate(match[3] ?? match[1], match[4] ?? match[2]);
  if (endColumn < startColumn || endRow < startRow) {
    fail("WORKSHEET_RESOURCE_LIMIT", "XLSX 工作表范围顺序无效");
  }
  const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
  if (!Number.isSafeInteger(cells) || cells > SPREADSHEET_LIMITS.maxWorksheetCells) {
    fail(
      "WORKSHEET_RESOURCE_LIMIT",
      `XLSX 工作表范围超过 ${SPREADSHEET_LIMITS.maxWorksheetCells} 个单元格`,
    );
  }
}

function assertXmlTextSegments(xml: string): void {
  let position = 0;
  while (position < xml.length) {
    const textStart = xml.indexOf(">", position);
    if (textStart < 0) break;
    const textEnd = xml.indexOf("<", textStart + 1);
    if (textEnd < 0) break;
    if (
      textEnd > textStart + 1
      && Buffer.byteLength(xml.slice(textStart + 1, textEnd), "utf8")
        > SPREADSHEET_LIMITS.maxCellTextBytes
    ) {
      fail(
        "CELL_RESOURCE_LIMIT",
        `XLSX 单元格文本超过 ${SPREADSHEET_LIMITS.maxCellTextBytes} 字节`,
      );
    }
    position = textEnd + 1;
  }
}

function decodeXmlAttribute(value: string): string {
  const codePoint = (digits: string, radix: number): string => {
    const parsed = Number.parseInt(digits, radix);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < 0
      || parsed > 0x10ffff
      || (parsed >= 0xd800 && parsed <= 0xdfff)
    ) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX XML 包含无效字符实体");
    }
    return String.fromCodePoint(parsed);
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => codePoint(digits, 16))
    .replace(/&#([0-9]+);/g, (_, digits: string) => codePoint(digits, 10))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function assertNoExternalRelationships(xml: string): void {
  const targetMode = /\bTargetMode\s*=\s*["']([^"']*)["']/gi;
  for (let match = targetMode.exec(xml); match; match = targetMode.exec(xml)) {
    if (decodeXmlAttribute(match[1]).trim().toLowerCase() !== "internal") {
      fail("EXTERNAL_RELATIONSHIP", "XLSX 包含外部关系，已拒绝解析");
    }
  }

  const target = /\bTarget\s*=\s*["']([^"']*)["']/gi;
  for (let match = target.exec(xml); match; match = target.exec(xml)) {
    const value = decodeXmlAttribute(match[1]).trim();
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(value)
      || /^[a-z]:[\\/]/i.test(value)
      || /^\\\\/.test(value)
      || /^\/\//.test(value)
    ) {
      fail("EXTERNAL_RELATIONSHIP", "XLSX 包含外部关系，已拒绝解析");
    }
  }
}

const UNSAFE_RELATIONSHIP_KINDS = new Set([
  "activex",
  "activexcontrolbinary",
  "attachedtemplate",
  "control",
  "ctrlprop",
  "customui",
  "embeddedpackage",
  "externallink",
  "oleobject",
  "package",
  "vbaproject",
  "vbaprojectsignature",
]);

function assertNoActiveRelationshipTypes(xml: string): void {
  const typeAttribute = /\bType\s*=\s*["']([^"']*)["']/gi;
  for (let match = typeAttribute.exec(xml); match; match = typeAttribute.exec(xml)) {
    let type = decodeXmlAttribute(match[1]).trim().toLowerCase();
    try {
      type = decodeURIComponent(type).toLowerCase();
    } catch {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX 关系类型 URI 编码无效");
    }
    const parts = type.replace(/[\/#]+$/, "").split(/[\/#]/);
    const kind = parts[parts.length - 1] ?? "";
    if (UNSAFE_RELATIONSHIP_KINDS.has(kind)) {
      fail("ACTIVE_CONTENT", "XLSX 包含宏、ActiveX、OLE 或嵌入包关系，已拒绝解析");
    }
  }
}

function isActiveContentType(contentType: string): boolean {
  const normalized = contentType.trim().toLowerCase();
  return normalized.includes("vba")
    || normalized.includes("macro")
    || normalized.includes("activex")
    || normalized.includes("oleobject")
    || normalized.includes("embeddedpackage");
}

function assertNoActiveContentTypes(xml: string, entryNames: ReadonlySet<string>): void {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const setUnique = (mapping: Map<string, string>, key: string, value: string): void => {
    if (mapping.has(key)) {
      fail("UNSAFE_ZIP_STRUCTURE", "XLSX 内容类型包含重复部件声明");
    }
    mapping.set(key, value);
  };
  const declaration = /<(?:[A-Za-z_][\w.-]*:)?(Default|Override)\b[^>]*>/gi;
  for (let match = declaration.exec(xml); match; match = declaration.exec(xml)) {
    const tag = match[0];
    const contentTypeMatch = /\bContentType\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!contentTypeMatch) continue;
    const contentType = decodeXmlAttribute(contentTypeMatch[1]).trim().toLowerCase();
    if (match[1].toLowerCase() === "default") {
      const extensionMatch = /\bExtension\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (!extensionMatch) continue;
      setUnique(
        defaults,
        decodeXmlAttribute(extensionMatch[1]).trim().toLowerCase(),
        contentType,
      );
    } else {
      const partNameMatch = /\bPartName\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (!partNameMatch) continue;
      let partName = decodeXmlAttribute(partNameMatch[1]).trim();
      try {
        partName = decodeURIComponent(partName);
      } catch {
        fail("UNSAFE_ZIP_STRUCTURE", "XLSX 内容类型部件 URI 编码无效");
      }
      partName = partName.replace(/^\/+/, "").toLowerCase();
      setUnique(overrides, partName, contentType);
    }
  }

  for (const entryName of entryNames) {
    const extension = /\.([^./]+)$/.exec(entryName)?.[1] ?? "";
    const effectiveContentType = overrides.get(entryName) ?? defaults.get(extension);
    if (effectiveContentType && isActiveContentType(effectiveContentType)) {
      fail("ACTIVE_CONTENT", "XLSX 包含宏启用或嵌入式活动内容类型，已拒绝解析");
    }
  }
}

function inspectXmlEntry(
  bytes: Buffer,
  entry: ZipEntry,
  entryNames: ReadonlySet<string>,
): void {
  const normalizedName = entry.name.toLowerCase();
  const xml = inflateZipEntry(bytes, entry).toString("utf8");
  if (xml.includes("\uFFFD") || xml.includes("\0") || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    fail("UNSAFE_ZIP_STRUCTURE", "XLSX XML 包含不安全的实体声明或无效编码");
  }
  if (normalizedName.endsWith(".rels")) {
    assertNoExternalRelationships(xml);
    assertNoActiveRelationshipTypes(xml);
  }
  if (normalizedName === "[content_types].xml") assertNoActiveContentTypes(xml, entryNames);
  if (normalizedName.startsWith("xl/worksheets/")) {
    const dimension = /<dimension\b[^>]*\bref\s*=\s*["']([^"']+)["']/i.exec(xml);
    if (dimension) assertWorksheetRange(dimension[1]);

    let cellCount = 0;
    const cellTag = /<c(?:\s|>)/gi;
    while (cellTag.exec(xml)) {
      cellCount += 1;
      if (cellCount > SPREADSHEET_LIMITS.maxWorksheetCells) {
        fail(
          "WORKSHEET_RESOURCE_LIMIT",
          `XLSX 工作表实际单元格超过 ${SPREADSHEET_LIMITS.maxWorksheetCells} 个`,
        );
      }
    }
    const cellReference = /<c\b[^>]*\br\s*=\s*["']\$?([A-Za-z]{1,4})\$?([0-9]+)["']/gi;
    for (let match = cellReference.exec(xml); match; match = cellReference.exec(xml)) {
      assertCellCoordinate(match[1], match[2]);
    }
    const rowReference = /<row\b[^>]*\br\s*=\s*["']([0-9]+)["']/gi;
    for (let match = rowReference.exec(xml); match; match = rowReference.exec(xml)) {
      assertCellCoordinate("A", match[1]);
    }
    assertXmlTextSegments(xml);
  } else if (normalizedName === "xl/sharedstrings.xml") {
    assertXmlTextSegments(xml);
  }
}

type SpreadsheetKind = "csv" | "xls" | "xlsx";

type SpreadsheetContainerInspection = {
  kind: SpreadsheetKind;
  entries: ZipEntry[];
};

function inspectSpreadsheetContainer(
  bytes: Buffer,
  fileName: string,
  inspectXml: boolean,
): SpreadsheetContainerInspection {
  if (bytes.length > SPREADSHEET_LIMITS.maxInputBytes) {
    fail(
      "SPREADSHEET_TOO_LARGE",
      `表格文件超过 ${SPREADSHEET_LIMITS.maxInputBytes / 1024 / 1024}MB 安全上限`,
    );
  }
  if (/\.csv$/i.test(fileName)) return { kind: "csv", entries: [] };
  if (
    bytes.length >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0
  ) {
    return { kind: "xls", entries: [] };
  }
  if (bytes.length < 4 || readUInt32(bytes, 0) !== ZIP_LOCAL_FILE) {
    return fail(
      "INVALID_SPREADSHEET_CONTAINER",
      "不是有效的 Excel 文件（.xlsx/.xls），文件可能已损坏或格式错误",
    );
  }

  const entries = parseZipEntries(bytes);
  const entryNames = new Set(entries.map((entry) => entry.name.toLowerCase()));
  for (const required of ["[content_types].xml", "_rels/.rels", "xl/workbook.xml"]) {
    if (!entryNames.has(required)) {
      fail("INVALID_SPREADSHEET_CONTAINER", "XLSX 缺少必要的 OOXML 条目");
    }
  }
  const worksheetCount = entries.filter((entry) => (
    /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)
  )).length;
  if (worksheetCount === 0 || worksheetCount > SPREADSHEET_LIMITS.maxSheets) {
    fail("WORKSHEET_RESOURCE_LIMIT", `XLSX 工作表数量超过上限 ${SPREADSHEET_LIMITS.maxSheets}`);
  }

  for (const entry of entries) {
    const normalizedName = entry.name.toLowerCase();
    if (
      normalizedName.startsWith("xl/externallinks/")
      || normalizedName.startsWith("xl/vbaproject")
      || normalizedName.startsWith("xl/activex/")
      || normalizedName.startsWith("xl/ctrlprops/")
      || normalizedName.startsWith("xl/macrosheets/")
      || normalizedName.startsWith("xl/dialogsheets/")
      || normalizedName.startsWith("xl/embeddings/")
      || normalizedName.startsWith("customui/")
    ) {
      fail("ACTIVE_CONTENT", "XLSX 包含外部链接、宏或嵌入对象，已拒绝解析");
    }
    if (inspectXml) {
      if (normalizedName.endsWith(".xml") || normalizedName.endsWith(".rels")) {
        inspectXmlEntry(bytes, entry, entryNames);
      } else {
        // CRC is part of the trust boundary even for parts ignored by SheetJS.
        // This also prevents parser differentials over corrupted stored entries.
        inflateZipEntry(bytes, entry);
      }
    }
  }
  return { kind: "xlsx", entries };
}

export function preflightSpreadsheetFile(bytes: Buffer, fileName: string): SpreadsheetKind {
  return inspectSpreadsheetContainer(bytes, fileName, true).kind;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { inflateRawSync } = require("node:zlib");
const XLSX = require(workerData.xlsxModulePath);
const limits = workerData.limits;
const spreadsheetSecurityCodes = new Set([
  "SPREADSHEET_TOO_LARGE", "INVALID_SPREADSHEET_CONTAINER", "UNSAFE_ZIP_STRUCTURE",
  "ZIP_RESOURCE_LIMIT", "EXTERNAL_RELATIONSHIP", "ACTIVE_CONTENT",
  "WORKSHEET_RESOURCE_LIMIT", "CELL_RESOURCE_LIMIT", "SPREADSHEET_RESULT_LIMIT",
  "SPREADSHEET_BUSY", "SPREADSHEET_PARSE_TIMEOUT", "SPREADSHEET_PARSE_FAILED",
]);

function securityError(code, message) {
  const error = new Error(message);
  error.securityCode = code;
  throw error;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function inflateEntry(bytes, entry) {
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let inflated;
  try {
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        securityError("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP stored entry sizes disagree");
      }
      inflated = Buffer.from(compressed);
    } else {
      inflated = inflateRawSync(compressed, {
        maxOutputLength: Math.min(limits.maxEntryUncompressedBytes + 1, entry.uncompressedSize + 1),
      });
    }
  } catch (error) {
    if (error && error.securityCode) throw error;
    securityError("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP entry cannot be safely inflated");
  }
  if (inflated.length !== entry.uncompressedSize || crc32(inflated) !== entry.crc32) {
    securityError("UNSAFE_ZIP_STRUCTURE", "XLSX ZIP entry size or CRC validation failed");
  }
  return inflated;
}

function xmlAttribute(value) {
  const codePoint = (digits, radix) => {
    const parsed = Number.parseInt(digits, radix);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < 0
      || parsed > 0x10ffff
      || (parsed >= 0xd800 && parsed <= 0xdfff)
    ) {
      securityError("UNSAFE_ZIP_STRUCTURE", "XLSX XML contains an invalid character entity");
    }
    return String.fromCodePoint(parsed);
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => codePoint(digits, 16))
    .replace(/&#([0-9]+);/g, (_, digits) => codePoint(digits, 10))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

const unsafeRelationshipKinds = new Set([
  "activex", "activexcontrolbinary", "attachedtemplate", "control", "ctrlprop",
  "customui", "embeddedpackage", "externallink", "oleobject", "package",
  "vbaproject", "vbaprojectsignature",
]);

function inspectRelationships(xml) {
  const targetMode = /\bTargetMode\s*=\s*["']([^"']*)["']/gi;
  for (let match = targetMode.exec(xml); match; match = targetMode.exec(xml)) {
    if (xmlAttribute(match[1]).trim().toLowerCase() !== "internal") {
      securityError("EXTERNAL_RELATIONSHIP", "XLSX 包含外部关系，已拒绝解析");
    }
  }
  const target = /\bTarget\s*=\s*["']([^"']*)["']/gi;
  for (let match = target.exec(xml); match; match = target.exec(xml)) {
    const value = xmlAttribute(match[1]).trim();
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(value)
      || /^[a-z]:[\\/]/i.test(value)
      || /^\\\\/.test(value)
      || /^\/\//.test(value)
    ) {
      securityError("EXTERNAL_RELATIONSHIP", "XLSX 包含外部关系，已拒绝解析");
    }
  }
  const typeAttribute = /\bType\s*=\s*["']([^"']*)["']/gi;
  for (let match = typeAttribute.exec(xml); match; match = typeAttribute.exec(xml)) {
    let type = xmlAttribute(match[1]).trim().toLowerCase();
    try {
      type = decodeURIComponent(type).toLowerCase();
    } catch {
      securityError("UNSAFE_ZIP_STRUCTURE", "XLSX relationship type URI is invalid");
    }
    const parts = type.replace(/[\/#]+$/, "").split(/[\/#]/);
    if (unsafeRelationshipKinds.has(parts[parts.length - 1] || "")) {
      securityError("ACTIVE_CONTENT", "XLSX contains an active-content relationship");
    }
  }
}

function isActiveContentType(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("vba")
    || normalized.includes("macro")
    || normalized.includes("activex")
    || normalized.includes("oleobject")
    || normalized.includes("embeddedpackage");
}

function inspectContentTypes(xml) {
  const defaults = new Map();
  const overrides = new Map();
  const setUnique = (mapping, key, value) => {
    if (mapping.has(key)) {
      securityError("UNSAFE_ZIP_STRUCTURE", "XLSX content types contain duplicate declarations");
    }
    mapping.set(key, value);
  };
  const declaration = /<(?:[A-Za-z_][\w.-]*:)?(Default|Override)\b[^>]*>/gi;
  for (let match = declaration.exec(xml); match; match = declaration.exec(xml)) {
    const tag = match[0];
    const contentTypeMatch = /\bContentType\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!contentTypeMatch) continue;
    const contentType = xmlAttribute(contentTypeMatch[1]).trim().toLowerCase();
    if (match[1].toLowerCase() === "default") {
      const extensionMatch = /\bExtension\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (extensionMatch) {
        setUnique(
          defaults,
          xmlAttribute(extensionMatch[1]).trim().toLowerCase(),
          contentType,
        );
      }
    } else {
      const partNameMatch = /\bPartName\s*=\s*["']([^"']*)["']/i.exec(tag);
      if (partNameMatch) {
        let partName = xmlAttribute(partNameMatch[1]).trim();
        try {
          partName = decodeURIComponent(partName);
        } catch {
          securityError("UNSAFE_ZIP_STRUCTURE", "XLSX content-type part URI is invalid");
        }
        partName = partName.replace(/^\/+/, "").toLowerCase();
        setUnique(overrides, partName, contentType);
      }
    }
  }
  for (const entry of workerData.entries) {
    const name = entry.name.toLowerCase();
    const extensionMatch = /\.([^./]+)$/.exec(name);
    const contentType = overrides.get(name) || defaults.get(extensionMatch ? extensionMatch[1] : "");
    if (contentType && isActiveContentType(contentType)) {
      securityError("ACTIVE_CONTENT", "XLSX contains an active-content MIME type");
    }
  }
}

function rawColumnNumber(column) {
  let value = 0;
  for (const character of column.toUpperCase()) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    value = value * 26 + code - 64;
  }
  return value;
}

function checkRawCoordinate(column, rowText) {
  const columnIndex = rawColumnNumber(column);
  const rowIndex = Number(rowText);
  if (
    columnIndex < 1
    || columnIndex > limits.maxWorksheetColumns
    || !Number.isSafeInteger(rowIndex)
    || rowIndex < 1
    || rowIndex > limits.maxWorksheetRows
  ) {
    securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX worksheet coordinate exceeds limits");
  }
}

function checkRawRange(reference) {
  const normalized = reference.replaceAll("$", "").trim();
  const match = /^([A-Za-z]{1,4})([0-9]+)(?::([A-Za-z]{1,4})([0-9]+))?$/.exec(normalized);
  if (!match) securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX worksheet range is invalid");
  checkRawCoordinate(match[1], match[2]);
  checkRawCoordinate(match[3] || match[1], match[4] || match[2]);
  const startColumn = rawColumnNumber(match[1]);
  const startRow = Number(match[2]);
  const endColumn = rawColumnNumber(match[3] || match[1]);
  const endRow = Number(match[4] || match[2]);
  const cells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
  if (
    endColumn < startColumn
    || endRow < startRow
    || !Number.isSafeInteger(cells)
    || cells > limits.maxWorksheetCells
  ) {
    securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX worksheet range exceeds limits");
  }
}

function checkRawTextSegments(xml) {
  let position = 0;
  while (position < xml.length) {
    const textStart = xml.indexOf(">", position);
    if (textStart < 0) break;
    const textEnd = xml.indexOf("<", textStart + 1);
    if (textEnd < 0) break;
    if (
      textEnd > textStart + 1
      && Buffer.byteLength(xml.slice(textStart + 1, textEnd), "utf8") > limits.maxCellTextBytes
    ) {
      securityError("CELL_RESOURCE_LIMIT", "XLSX cell text exceeds limits");
    }
    position = textEnd + 1;
  }
}

function inspectRawSpreadsheet(bytes) {
  if (workerData.kind !== "xlsx") return;
  for (const entry of workerData.entries) {
    const name = entry.name.toLowerCase();
    const inflated = inflateEntry(bytes, entry);
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const xml = inflated.toString("utf8");
    if (xml.includes("\uFFFD") || xml.includes("\0") || /<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
      securityError("UNSAFE_ZIP_STRUCTURE", "XLSX XML encoding or entity declaration is unsafe");
    }
    if (name.endsWith(".rels")) inspectRelationships(xml);
    if (name === "[content_types].xml") inspectContentTypes(xml);
    if (name.startsWith("xl/worksheets/")) {
      const dimension = /<dimension\b[^>]*\bref\s*=\s*["']([^"']+)["']/i.exec(xml);
      if (dimension) checkRawRange(dimension[1]);
      let cellCount = 0;
      const cellTag = /<c(?:\s|>)/gi;
      while (cellTag.exec(xml)) {
        cellCount += 1;
        if (cellCount > limits.maxWorksheetCells) {
          securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX worksheet has too many cells");
        }
      }
      const cellReference = /<c\b[^>]*\br\s*=\s*["']\$?([A-Za-z]{1,4})\$?([0-9]+)["']/gi;
      for (let match = cellReference.exec(xml); match; match = cellReference.exec(xml)) {
        checkRawCoordinate(match[1], match[2]);
      }
      const rowReference = /<row\b[^>]*\br\s*=\s*["']([0-9]+)["']/gi;
      for (let match = rowReference.exec(xml); match; match = rowReference.exec(xml)) {
        checkRawCoordinate("A", match[1]);
      }
      checkRawTextSegments(xml);
    } else if (name === "xl/sharedstrings.xml") {
      checkRawTextSegments(xml);
    }
  }
}

function checkRange(reference) {
  if (!reference) return;
  let range;
  try {
    range = XLSX.utils.decode_range(reference);
  } catch {
    securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX 工作表范围无效");
  }
  const rows = range.e.r - range.s.r + 1;
  const columns = range.e.c - range.s.c + 1;
  const cells = rows * columns;
  if (
    rows < 1 || rows > limits.maxWorksheetRows
    || columns < 1 || columns > limits.maxWorksheetColumns
    || !Number.isSafeInteger(cells) || cells > limits.maxWorksheetCells
  ) {
    securityError("WORKSHEET_RESOURCE_LIMIT", "XLSX 工作表范围超过安全上限");
  }
}

function checkCellText(value) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limits.maxCellTextBytes) {
    securityError("CELL_RESOURCE_LIMIT", "XLSX 单元格文本超过安全上限");
  }
}

let returnedBytes = 0;

function reserveReturnedBytes(bytes) {
  returnedBytes += bytes;
  if (!Number.isSafeInteger(returnedBytes) || returnedBytes > limits.maxReturnedBytes) {
    securityError("SPREADSHEET_RESULT_LIMIT", "表格解析结果超过安全返回上限");
  }
}

function reserveReturnedValue(value) {
  // 64 bytes is a deliberately conservative allowance for the structured-clone
  // slot/object metadata.  String payload is then charged by exact UTF-8 bytes.
  let payloadBytes = 0;
  if (typeof value === "string") payloadBytes = Buffer.byteLength(value, "utf8");
  else if (typeof value === "number" || typeof value === "bigint") payloadBytes = 8;
  else if (typeof value === "boolean") payloadBytes = 1;
  else if (value instanceof Date) payloadBytes = 16;
  else if (value !== null && value !== undefined) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      securityError("SPREADSHEET_RESULT_LIMIT", "表格解析结果包含不可安全返回的值");
    }
    payloadBytes = Buffer.byteLength(serialized || String(value), "utf8");
  }
  reserveReturnedBytes(64 + payloadBytes);
}

try {
  const bytes = Buffer.from(workerData.bytes);
  inspectRawSpreadsheet(bytes);
  const readInput = workerData.kind === "csv"
    ? bytes.toString("utf8").replace(/^\uFEFF/, "")
    : bytes;
  const baseReadOptions = workerData.kind === "csv"
    ? { type: "string", raw: true, cellDates: true, cellFormula: false, cellHTML: false,
        cellNF: false, cellStyles: false, bookDeps: false, bookVBA: false }
    : { type: "buffer", cellDates: true, cellFormula: false, cellHTML: false,
        cellNF: false, cellStyles: false, bookDeps: false, bookVBA: false };
  // Read the workbook directory without materializing every worksheet.  Once a
  // sheet is selected, parse only that sheet.  This bounds memory by one sheet
  // instead of the sum of a large multi-sheet workbook.
  const workbookDirectory = XLSX.read(readInput, { ...baseReadOptions, bookSheets: true });
  const sheetNames = workbookDirectory.SheetNames;
  if (!Array.isArray(sheetNames) || sheetNames.length === 0) {
    securityError("SPREADSHEET_PARSE_FAILED", "Excel 没有 sheet");
  }
  if (sheetNames.length > limits.maxSheets) {
    securityError("WORKSHEET_RESOURCE_LIMIT", "Excel 工作表数量超过安全上限");
  }
  for (const availableSheetName of sheetNames) {
    checkCellText(availableSheetName);
  }
  if (workerData.operation === "sheetNames") {
    for (const availableSheetName of sheetNames) {
      reserveReturnedBytes(64 + Buffer.byteLength(availableSheetName, "utf8"));
    }
    parentPort.postMessage({ ok: true, sheetNames });
  } else {
    const requestedSheetName = typeof workerData.requestedSheetName === "string"
      ? workerData.requestedSheetName
      : "";
    const sheetName = requestedSheetName || sheetNames[0];
    if (!sheetNames.includes(sheetName)) {
      securityError("SPREADSHEET_PARSE_FAILED", "指定的工作表不存在");
    }
    const workbook = XLSX.read(readInput, { ...baseReadOptions, sheets: sheetName });
    reserveReturnedBytes(64 + Buffer.byteLength(sheetName, "utf8"));
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) securityError("SPREADSHEET_PARSE_FAILED", "指定的工作表不可读取");
    checkRange(sheet["!ref"]);
    checkRange(sheet["!fullref"]);

    let cellCount = 0;
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith("!")) continue;
      cellCount += 1;
      if (cellCount > limits.maxWorksheetCells) {
        securityError("WORKSHEET_RESOURCE_LIMIT", "Excel 实际单元格数量超过安全上限");
      }
      if (cell && typeof cell === "object") {
        checkCellText(cell.v);
        checkCellText(cell.w);
        checkCellText(cell.f);
        if (cell.l && typeof cell.l === "object") checkCellText(cell.l.Target);
      }
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    if (!Array.isArray(rows)) {
      securityError("SPREADSHEET_PARSE_FAILED", "工作表行数据无效");
    }
    if (rows.length > limits.maxWorksheetRows) {
      securityError("WORKSHEET_RESOURCE_LIMIT", "Excel 行数超过安全上限");
    }
    let returnedCells = 0;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length > limits.maxWorksheetColumns) {
        securityError("WORKSHEET_RESOURCE_LIMIT", "Excel 列数超过安全上限");
      }
      reserveReturnedBytes(64);
      returnedCells += row.length;
      if (returnedCells > limits.maxWorksheetCells) {
        securityError("WORKSHEET_RESOURCE_LIMIT", "Excel 单元格数量超过安全上限");
      }
      for (const value of row) {
        checkCellText(value);
        reserveReturnedValue(value);
      }
    }
    parentPort.postMessage({ ok: true, sheetName, rows });
  }
} catch (error) {
  const knownSecurityError = Boolean(
    error && spreadsheetSecurityCodes.has(error.securityCode),
  );
  parentPort.postMessage({
    ok: false,
    code: knownSecurityError ? error.securityCode : "SPREADSHEET_PARSE_FAILED",
    message: knownSecurityError && error instanceof Error
      ? error.message
      : "表格解析失败，文件可能损坏或格式不受支持",
  });
}
`;

function isSecurityCode(value: unknown): value is SpreadsheetSecurityCode {
  return typeof value === "string" && [
    "SPREADSHEET_TOO_LARGE",
    "INVALID_SPREADSHEET_CONTAINER",
    "UNSAFE_ZIP_STRUCTURE",
    "ZIP_RESOURCE_LIMIT",
    "EXTERNAL_RELATIONSHIP",
    "ACTIVE_CONTENT",
    "WORKSHEET_RESOURCE_LIMIT",
    "CELL_RESOURCE_LIMIT",
    "SPREADSHEET_RESULT_LIMIT",
    "SPREADSHEET_BUSY",
    "SPREADSHEET_PARSE_TIMEOUT",
    "SPREADSHEET_PARSE_FAILED",
  ].includes(value);
}

type ParserQueueMember = {
  resolve: (release: () => void) => void;
  reject: (error: SpreadsheetSecurityError) => void;
  timer: NodeJS.Timeout;
};

let activeParsers = 0;
const parserQueue: ParserQueueMember[] = [];

function parserRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeParsers -= 1;
    const next = parserQueue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    activeParsers += 1;
    next.resolve(parserRelease());
  };
}

function acquireParserSlot(): Promise<() => void> {
  if (activeParsers < SPREADSHEET_LIMITS.maxConcurrentParsers) {
    activeParsers += 1;
    return Promise.resolve(parserRelease());
  }
  if (parserQueue.length >= SPREADSHEET_LIMITS.maxQueuedParsers) {
    return Promise.reject(new SpreadsheetSecurityError(
      "SPREADSHEET_BUSY",
      "表格解析任务过多，请稍后重试",
    ));
  }
  return new Promise((resolve, reject) => {
    const member: ParserQueueMember = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = parserQueue.indexOf(member);
        if (index >= 0) parserQueue.splice(index, 1);
        reject(new SpreadsheetSecurityError(
          "SPREADSHEET_BUSY",
          "表格解析排队超时，请稍后重试",
        ));
      }, SPREADSHEET_LIMITS.maxParserQueueWaitMs),
    };
    parserQueue.push(member);
  });
}

type SpreadsheetWorkerResult = SpreadsheetRows | { sheetNames: string[] };

async function runSpreadsheetWorker(
  input: ArrayBuffer | Buffer,
  fileName: string,
  request: { operation: "rows"; sheetName?: string } | { operation: "sheetNames" },
): Promise<SpreadsheetWorkerResult> {
  if (input.byteLength > SPREADSHEET_LIMITS.maxInputBytes) {
    fail(
      "SPREADSHEET_TOO_LARGE",
      `表格文件超过 ${SPREADSHEET_LIMITS.maxInputBytes / 1024 / 1024}MB 安全上限`,
    );
  }
  const releaseParser = await acquireParserSlot();

  try {
    const bytes = input instanceof Buffer ? Buffer.from(input) : Buffer.from(new Uint8Array(input));
    // Only bounded central-directory validation remains on the API thread.  ZIP
    // inflation, XML scanning and XLSX parsing all execute inside the same
    // memory-limited, timeout-controlled worker below.
    const { kind, entries } = inspectSpreadsheetContainer(bytes, fileName, false);
    const transferable = Uint8Array.from(bytes).buffer;
    return await new Promise<SpreadsheetWorkerResult>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          bytes: transferable,
          kind,
          entries,
          limits: SPREADSHEET_LIMITS,
          xlsxModulePath: XLSX_MODULE_PATH,
          operation: request.operation,
          requestedSheetName: request.operation === "rows" ? request.sheetName : undefined,
        },
        transferList: [transferable],
        resourceLimits: {
          maxOldGenerationSizeMb: SPREADSHEET_LIMITS.workerMaxOldGenerationMb,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        operation();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const timeoutError = new SpreadsheetSecurityError(
          "SPREADSHEET_PARSE_TIMEOUT",
          `表格解析超过 ${SPREADSHEET_LIMITS.parseTimeoutMs / 1000} 秒安全上限`,
        );
        // Keep the parser slot until the worker has actually terminated.  This
        // prevents a timeout storm from temporarily exceeding the concurrency cap.
        void worker.terminate().then(
          () => reject(timeoutError),
          () => reject(timeoutError),
        );
      }, SPREADSHEET_LIMITS.parseTimeoutMs);

      worker.once("message", (message: {
        ok?: boolean;
        code?: unknown;
        message?: unknown;
        sheetName?: unknown;
        sheetNames?: unknown;
        rows?: unknown;
      }) => {
        if (
          message.ok === true
          && Array.isArray(message.sheetNames)
          && message.sheetNames.every((name) => typeof name === "string")
        ) {
          finish(() => resolve({ sheetNames: message.sheetNames as string[] }));
          return;
        }
        if (
          message.ok === true
          && typeof message.sheetName === "string"
          && Array.isArray(message.rows)
        ) {
          finish(() => resolve({ sheetName: message.sheetName as string, rows: message.rows as unknown[][] }));
          return;
        }
        const code = isSecurityCode(message.code) ? message.code : "SPREADSHEET_PARSE_FAILED";
        const detail = typeof message.message === "string" && message.message
          ? message.message
          : "表格解析失败";
        finish(() => reject(new SpreadsheetSecurityError(code, detail)));
      });
      worker.once("error", () => {
        finish(() => reject(new SpreadsheetSecurityError(
          "SPREADSHEET_PARSE_FAILED",
          "表格解析进程异常退出，文件可能损坏或超过安全资源限制",
        )));
      });
      worker.once("exit", (code) => {
        if (settled) return;
        finish(() => reject(new SpreadsheetSecurityError(
          "SPREADSHEET_PARSE_FAILED",
          code === 0
            ? "表格解析进程未返回结果"
            : "表格解析进程异常退出，文件可能损坏或超过安全资源限制",
        )));
      });
    });
  } finally {
    releaseParser();
  }
}

export async function parseSpreadsheetRows(
  input: ArrayBuffer | Buffer,
  fileName: string,
  options: SpreadsheetParseOptions = {},
): Promise<SpreadsheetRows> {
  const result = await runSpreadsheetWorker(input, fileName, {
    operation: "rows",
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
  });
  if ("rows" in result) return result;
  throw new SpreadsheetSecurityError("SPREADSHEET_PARSE_FAILED", "表格解析未返回行数据");
}

export async function listSpreadsheetSheetNames(
  input: ArrayBuffer | Buffer,
  fileName: string,
): Promise<string[]> {
  const result = await runSpreadsheetWorker(input, fileName, { operation: "sheetNames" });
  if ("sheetNames" in result) return result.sheetNames;
  throw new SpreadsheetSecurityError("SPREADSHEET_PARSE_FAILED", "表格解析未返回工作表清单");
}
