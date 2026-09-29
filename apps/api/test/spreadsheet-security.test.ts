import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import {
  listSpreadsheetSheetNames,
  parseSpreadsheetRows,
  preflightSpreadsheetFile,
  SPREADSHEET_LIMITS,
  SpreadsheetSecurityError,
} from "../src/services/spreadsheet-security.js";

type TestZipEntry = {
  name: string;
  data?: Buffer | string;
  flags?: number;
  method?: 0 | 8;
  centralCrc32?: number;
  localCrc32?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  dataDescriptor?: "signed" | "unsigned";
  descriptorCrc32?: number;
  gapAfter?: Buffer | string;
};

const TEST_CRC32_TABLE = (() => {
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

function testCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = TEST_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0);
    const method = entry.method ?? 0;
    const compressedSize = entry.declaredCompressedSize ?? data.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const centralCrc32 = entry.centralCrc32 ?? testCrc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(
      entry.localCrc32 ?? (entry.dataDescriptor ? 0 : centralCrc32),
      14,
    );
    local.writeUInt32LE(
      entry.localCompressedSize ?? (entry.dataDescriptor ? 0 : compressedSize),
      18,
    );
    local.writeUInt32LE(
      entry.localUncompressedSize ?? (entry.dataDescriptor ? 0 : uncompressedSize),
      22,
    );
    local.writeUInt16LE(name.length, 26);
    const descriptor = entry.dataDescriptor
      ? Buffer.alloc(entry.dataDescriptor === "signed" ? 16 : 12)
      : Buffer.alloc(0);
    const descriptorOffset = entry.dataDescriptor === "signed" ? 4 : 0;
    if (entry.dataDescriptor === "signed") descriptor.writeUInt32LE(0x08074b50, 0);
    if (entry.dataDescriptor) {
      descriptor.writeUInt32LE(entry.descriptorCrc32 ?? centralCrc32, descriptorOffset);
      descriptor.writeUInt32LE(compressedSize, descriptorOffset + 4);
      descriptor.writeUInt32LE(uncompressedSize, descriptorOffset + 8);
    }
    const gap = Buffer.isBuffer(entry.gapAfter)
      ? entry.gapAfter
      : Buffer.from(entry.gapAfter ?? "", "utf8");
    localParts.push(local, name, data, descriptor, gap);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(centralCrc32, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + data.length + descriptor.length + gap.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makeOverlappingZip(): Buffer {
  const outerName = Buffer.from("outer.bin");
  const innerName = Buffer.from("inner.bin");
  const innerData = Buffer.from("inner-value");
  const innerCrc = testCrc32(innerData);
  const innerLocal = Buffer.alloc(30);
  innerLocal.writeUInt32LE(0x04034b50, 0);
  innerLocal.writeUInt16LE(20, 4);
  innerLocal.writeUInt32LE(innerCrc, 14);
  innerLocal.writeUInt32LE(innerData.length, 18);
  innerLocal.writeUInt32LE(innerData.length, 22);
  innerLocal.writeUInt16LE(innerName.length, 26);

  const prefix = Buffer.from("prefix");
  const outerData = Buffer.concat([prefix, innerLocal, innerName, innerData]);
  const outerCrc = testCrc32(outerData);
  const outerLocal = Buffer.alloc(30);
  outerLocal.writeUInt32LE(0x04034b50, 0);
  outerLocal.writeUInt16LE(20, 4);
  outerLocal.writeUInt32LE(outerCrc, 14);
  outerLocal.writeUInt32LE(outerData.length, 18);
  outerLocal.writeUInt32LE(outerData.length, 22);
  outerLocal.writeUInt16LE(outerName.length, 26);

  const localArea = Buffer.concat([outerLocal, outerName, outerData]);
  const innerOffset = outerLocal.length + outerName.length + prefix.length;
  const centralRecord = (
    name: Buffer,
    crc: number,
    size: number,
    localOffset: number,
  ): Buffer => {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    return Buffer.concat([central, name]);
  };
  const centralDirectory = Buffer.concat([
    centralRecord(outerName, outerCrc, outerData.length, 0),
    centralRecord(innerName, innerCrc, innerData.length, innerOffset),
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localArea.length, 16);
  return Buffer.concat([localArea, centralDirectory, eocd]);
}

function minimalXlsx(
  extraEntries: TestZipEntry[] = [],
  relationshipXml = "<Relationships/>",
  contentTypesXml = "<Types/>",
): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", data: contentTypesXml },
    { name: "_rels/.rels", data: relationshipXml },
    { name: "xl/workbook.xml", data: "<workbook/>" },
    {
      name: "xl/worksheets/sheet1.xml",
      data: '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>',
    },
    ...extraEntries,
  ]);
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SpreadsheetSecurityError);
    return (error as SpreadsheetSecurityError).code;
  }
}

describe("spreadsheet security preflight", () => {
  test("accepts a bounded OOXML package", () => {
    expect(preflightSpreadsheetFile(minimalXlsx(), "sample.xlsx")).toBe("xlsx");
  });

  test("rejects malformed and encrypted ZIP containers", () => {
    expect(errorCode(() => preflightSpreadsheetFile(Buffer.from("PK broken"), "bad.xlsx")))
      .toBe("INVALID_SPREADSHEET_CONTAINER");
    const encrypted = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>", flags: 1 },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(encrypted, "encrypted.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");
  });

  test("rejects too many ZIP entries", () => {
    const entries = Array.from(
      { length: SPREADSHEET_LIMITS.maxArchiveEntries + 1 },
      (_, index) => ({ name: `safe/${index}.bin`, data: "" }),
    );
    expect(errorCode(() => preflightSpreadsheetFile(makeZip(entries), "many.xlsx")))
      .toBe("ZIP_RESOURCE_LIMIT");
  });

  test("rejects per-entry and aggregate uncompressed-size claims", () => {
    const oversizedEntry = makeZip([
      {
        name: "huge.bin",
        data: "x",
        method: 8,
        declaredCompressedSize: 1,
        declaredUncompressedSize: SPREADSHEET_LIMITS.maxEntryUncompressedBytes + 1,
      },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(oversizedEntry, "huge.xlsx")))
      .toBe("ZIP_RESOURCE_LIMIT");

    const aggregateEntries = Array.from({ length: 97 }, (_, index) => ({
      name: `payload/${index}.bin`,
      data: Buffer.alloc(10 * 1024),
      method: 8 as const,
      declaredCompressedSize: 10 * 1024,
      declaredUncompressedSize: 1024 * 1024,
    }));
    expect(errorCode(() => preflightSpreadsheetFile(makeZip(aggregateEntries), "aggregate.xlsx")))
      .toBe("ZIP_RESOURCE_LIMIT");
  });

  test("rejects excessive compression ratios", () => {
    const bomb = makeZip([
      {
        name: "bomb.bin",
        data: "x",
        method: 8,
        declaredCompressedSize: 1,
        declaredUncompressedSize: SPREADSHEET_LIMITS.compressionRatioMinBytes,
      },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(bomb, "bomb.xlsx")))
      .toBe("ZIP_RESOURCE_LIMIT");
  });

  test("rejects external relationships and active content", () => {
    const external = minimalXlsx(
      [],
      '<Relationships><Relationship Target="https://example.invalid/a" TargetMode="External"/></Relationships>',
    );
    expect(errorCode(() => preflightSpreadsheetFile(external, "external.xlsx")))
      .toBe("EXTERNAL_RELATIONSHIP");

    const encodedExternal = minimalXlsx(
      [],
      '<Relationships><Relationship Target="&#x68;ttps://example.invalid/a" TargetMode="&#x45;xternal"/></Relationships>',
    );
    expect(errorCode(() => preflightSpreadsheetFile(encodedExternal, "encoded-external.xlsx")))
      .toBe("EXTERNAL_RELATIONSHIP");

    expect(errorCode(() => preflightSpreadsheetFile(
      minimalXlsx([{ name: "xl/vbaProject.bin", data: "macro" }]),
      "macro.xlsx",
    ))).toBe("ACTIVE_CONTENT");

    const activeContentTypes = [
      "application/vnd.ms-office.vbaProject",
      "application/vnd.ms-office.activeX",
      "application/vnd.openxmlformats-officedocument.oleObject",
      "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
    ];
    for (const [index, contentType] of activeContentTypes.entries()) {
      const partName = index === activeContentTypes.length - 1
        ? "/xl/%77orkbook.xml"
        : `/payload/custom-${index}.dat`;
      const extraEntries = index === activeContentTypes.length - 1
        ? []
        : [{ name: partName.slice(1), data: "opaque" }];
      const contentTypes = `<Types><Override PartName="${partName}" ContentType="${contentType}"/></Types>`;
      expect(errorCode(() => preflightSpreadsheetFile(
        minimalXlsx(extraEntries, "<Relationships/>", contentTypes),
        `active-content-type-${index}.xlsx`,
      ))).toBe("ACTIVE_CONTENT");
    }

    const customPathMacroRelationship = minimalXlsx(
      [{ name: "payload/opaque.dat", data: "macro" }],
      '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/v&#x25;62aProject" Target="../payload/opaque.dat"/></Relationships>',
    );
    expect(errorCode(() => preflightSpreadsheetFile(
      customPathMacroRelationship,
      "custom-path-macro.xlsx",
    ))).toBe("ACTIVE_CONTENT");

    const ambiguousContentType = minimalXlsx(
      [{ name: "payload/custom.dat", data: "opaque" }],
      "<Relationships/>",
      '<Types><Override PartName="/payload/custom.dat" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/payload/custom.dat" ContentType="application/octet-stream"/></Types>',
    );
    expect(errorCode(() => preflightSpreadsheetFile(
      ambiguousContentType,
      "ambiguous-content-type.xlsx",
    ))).toBe("UNSAFE_ZIP_STRUCTURE");
  });

  test("accepts valid data descriptors and rejects ZIP header, descriptor, CRC and layout ambiguity", () => {
    const validDescriptor = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>", dataDescriptor: "signed" },
      { name: "_rels/.rels", data: "<Relationships/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/worksheets/sheet1.xml", data: "<worksheet/>", dataDescriptor: "unsigned" },
    ]);
    expect(preflightSpreadsheetFile(validDescriptor, "descriptor.xlsx")).toBe("xlsx");

    const localSizeMismatch = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>", localCompressedSize: 99 },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(localSizeMismatch, "local-size.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");

    const descriptorMismatch = makeZip([
      {
        name: "[Content_Types].xml",
        data: "<Types/>",
        dataDescriptor: "signed",
        descriptorCrc32: 0x12345678,
      },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(descriptorMismatch, "descriptor-crc.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");

    const centralCrcMismatch = minimalXlsx([
      { name: "safe/value.dat", data: "value", centralCrc32: 0x12345678, localCrc32: 0x12345678 },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(centralCrcMismatch, "central-crc.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");

    const undeclaredGap = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>", gapAfter: "hidden" },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(undeclaredGap, "gap.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");

    expect(errorCode(() => preflightSpreadsheetFile(makeOverlappingZip(), "overlap.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");
  });

  test("rejects unsafe XML entities, oversized ranges and text cells", () => {
    const entity = makeZip([
      { name: "[Content_Types].xml", data: '<!DOCTYPE x [<!ENTITY e "x">]><Types/>' },
      { name: "_rels/.rels", data: "<Relationships/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/worksheets/sheet1.xml", data: "<worksheet/>" },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(entity, "entity.xlsx")))
      .toBe("UNSAFE_ZIP_STRUCTURE");

    const hugeRange = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "_rels/.rels", data: "<Relationships/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      {
        name: "xl/worksheets/sheet1.xml",
        data: '<worksheet><dimension ref="A1:XFD1048576"/><sheetData/></worksheet>',
      },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(hugeRange, "range.xlsx")))
      .toBe("WORKSHEET_RESOURCE_LIMIT");

    const longText = "x".repeat(SPREADSHEET_LIMITS.maxCellTextBytes + 1);
    const oversizedText = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "_rels/.rels", data: "<Relationships/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<worksheet><dimension ref="A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${longText}</t></is></c></row></sheetData></worksheet>`,
      },
    ]);
    expect(errorCode(() => preflightSpreadsheetFile(oversizedText, "cell.xlsx")))
      .toBe("CELL_RESOURCE_LIMIT");
  });
});

describe("isolated spreadsheet parser", () => {
  test("lists and selects workbook sheets without returning every sheet's rows together", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["a", "b", "c"],
      [1, 2, 3],
    ]), "金额");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["x", "y", "z"],
      [4, 5, 6],
    ]), "件数");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    await expect(listSpreadsheetSheetNames(bytes, "multi.xlsx")).resolves.toEqual(["金额", "件数"]);
    await expect(parseSpreadsheetRows(bytes, "multi.xlsx", { sheetName: "件数" })).resolves.toMatchObject({
      sheetName: "件数",
      rows: [["x", "y", "z"], [4, 5, 6]],
    });
  });
  test("parses normal XLSX and CSV data through the worker", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["日期", "SKU", "金额"],
      [new Date(2026, 6, 1), "000123", 12.34],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "数据");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellDates: true });

    const parsed = await parseSpreadsheetRows(bytes, "normal.xlsx");
    expect(parsed.sheetName).toBe("数据");
    expect(parsed.rows[0]).toEqual(["日期", "SKU", "金额"]);
    expect(parsed.rows[1]?.[1]).toBe("000123");
    expect(parsed.rows[1]?.[2]).toBe(12.34);

    await expect(parseSpreadsheetRows(
      Buffer.from("日期,SKU,金额\n2026-07-01,000123,12.34", "utf8"),
      "normal.csv",
    )).resolves.toMatchObject({
      sheetName: "Sheet1",
      rows: [["日期", "SKU", "金额"], ["2026-07-01", "000123", "12.34"]],
    });
  });

  test("keeps legacy XLS parsing inside the same isolated worker", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["SKU", "数量"],
      ["0001", 2],
    ]), "Sheet1");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "biff8" });
    await expect(parseSpreadsheetRows(bytes, "legacy.xls")).resolves.toMatchObject({
      rows: [["SKU", "数量"], ["0001", 2]],
    });
  });

  test("runs raw XML active-content inspection inside the worker", async () => {
    const customMacro = minimalXlsx(
      [{ name: "payload/custom.dat", data: "opaque" }],
      "<Relationships/>",
      '<Types><Override PartName="/payload/custom.dat" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    );
    await expect(parseSpreadsheetRows(customMacro, "custom-macro.xlsx")).rejects.toMatchObject({
      code: "ACTIVE_CONTENT",
    });

    const customRelationship = minimalXlsx(
      [{ name: "payload/custom.dat", data: "opaque" }],
      '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/oleObject" Target="payload/custom.dat"/></Relationships>',
    );
    await expect(parseSpreadsheetRows(customRelationship, "custom-ole.xlsx"))
      .rejects.toMatchObject({ code: "ACTIVE_CONTENT" });

    const corruptIgnoredPart = minimalXlsx([
      {
        name: "safe/ignored.dat",
        data: "value",
        centralCrc32: 0x12345678,
        localCrc32: 0x12345678,
      },
    ]);
    await expect(parseSpreadsheetRows(corruptIgnoredPart, "corrupt-part.xlsx"))
      .rejects.toMatchObject({ code: "UNSAFE_ZIP_STRUCTURE" });
  });

  test("acquires the parser gate before container preflight", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["SKU"], ["0001"]]),
      "Sheet1",
    );
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const occupying = Array.from(
      {
        length: SPREADSHEET_LIMITS.maxConcurrentParsers
          + SPREADSHEET_LIMITS.maxQueuedParsers,
      },
      (_, index) => parseSpreadsheetRows(bytes, `occupying-${index}.xlsx`),
    );

    await expect(parseSpreadsheetRows(Buffer.from("PK broken"), "malformed.xlsx"))
      .rejects.toMatchObject({ code: "SPREADSHEET_BUSY" });
    await expect(Promise.all(occupying)).resolves.toHaveLength(occupying.length);
  });

  test("rejects a structured-clone result above the 64MiB conservative budget", async () => {
    const wideRow = `x${",".repeat(1023)}x`;
    const csv = Buffer.from(Array.from({ length: 1024 }, () => wideRow).join("\n"), "utf8");
    expect(csv.length).toBeLessThan(SPREADSHEET_LIMITS.maxInputBytes);
    await expect(parseSpreadsheetRows(csv, "wide.csv")).rejects.toMatchObject({
      code: "SPREADSHEET_RESULT_LIMIT",
    });
  });

  test("bounds concurrent workers and the parser queue", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["SKU"], ["0001"]]),
      "Sheet1",
    );
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const requestCount =
      SPREADSHEET_LIMITS.maxConcurrentParsers
      + SPREADSHEET_LIMITS.maxQueuedParsers
      + 1;
    const results = await Promise.allSettled(
      Array.from({ length: requestCount }, (_, index) => (
        parseSpreadsheetRows(bytes, `concurrent-${index}.xlsx`)
      )),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      SPREADSHEET_LIMITS.maxConcurrentParsers + SPREADSHEET_LIMITS.maxQueuedParsers,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "SPREADSHEET_BUSY" },
    });
  });
});
