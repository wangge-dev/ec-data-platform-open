import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { SPREADSHEET_LIMITS } from "../src/services/spreadsheet-security.js";

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
  opendir: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  lstat: fsMocks.lstat,
  open: fsMocks.open,
  opendir: fsMocks.opendir,
  realpath: fsMocks.realpath,
}));

import {
  MAX_SCAN_DIRECTORY_ENTRIES,
  readSpreadsheetFileSafely,
  SafeSpreadsheetDirectory,
} from "../src/services/safe-spreadsheet-file.js";

function fakeStats(options: {
  dev?: number;
  ino?: number;
  size?: number;
  file?: boolean;
  directory?: boolean;
  symlink?: boolean;
} = {}) {
  return {
    dev: options.dev ?? 1,
    ino: options.ino ?? 2,
    size: options.size ?? 4,
    isFile: () => options.file ?? false,
    isDirectory: () => options.directory ?? false,
    isSymbolicLink: () => options.symlink ?? false,
  };
}

function fakeHandle(stats = fakeStats({ file: true })) {
  let readCount = 0;
  return {
    stat: vi.fn(async () => stats),
    read: vi.fn(async (buffer: Buffer, offset: number) => {
      if (readCount++ > 0) return { bytesRead: 0, buffer };
      buffer.write("safe", offset, "utf8");
      return { bytesRead: 4, buffer };
    }),
    close: vi.fn(async () => undefined),
  };
}

function fakeDirectoryHandle(stats = fakeStats({ directory: true })) {
  return {
    fd: 17,
    stat: vi.fn(async () => stats),
    close: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bounded spreadsheet scan file reader", () => {
  test("rejects a symbolic-link file before open", async () => {
    fsMocks.lstat.mockResolvedValue(fakeStats({ symlink: true }));

    await expect(readSpreadsheetFileSafely("orders.xlsx")).rejects.toMatchObject({
      code: "SPREADSHEET_PARSE_FAILED",
    });
    expect(fsMocks.open).not.toHaveBeenCalled();
  });

  test("rejects an oversized file before allocating or opening it", async () => {
    fsMocks.lstat.mockResolvedValue(fakeStats({
      file: true,
      size: SPREADSHEET_LIMITS.maxInputBytes + 1,
    }));

    await expect(readSpreadsheetFileSafely("orders.xlsx")).rejects.toMatchObject({
      code: "SPREADSHEET_TOO_LARGE",
    });
    expect(fsMocks.open).not.toHaveBeenCalled();
  });

  test("rejects a file swapped between lstat and open and still closes the handle", async () => {
    const before = fakeStats({ file: true, dev: 1, ino: 2 });
    const handle = fakeHandle(fakeStats({ file: true, dev: 1, ino: 3 }));
    fsMocks.lstat.mockResolvedValue(before);
    fsMocks.open.mockResolvedValue(handle);

    await expect(readSpreadsheetFileSafely("orders.xlsx")).rejects.toMatchObject({
      code: "SPREADSHEET_PARSE_FAILED",
    });
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  test("returns only the bytes read from an identity-stable regular file", async () => {
    const stats = fakeStats({ file: true, dev: 7, ino: 9, size: 4 });
    const handle = fakeHandle(stats);
    fsMocks.lstat.mockResolvedValue(stats);
    fsMocks.open.mockResolvedValue(handle);

    await expect(readSpreadsheetFileSafely("orders.xlsx")).resolves.toEqual(
      Buffer.from("safe"),
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });

  test("rejects a configured directory whose canonical path reveals an ancestor link", async () => {
    const requested = path.resolve("scan");
    fsMocks.realpath.mockResolvedValue(path.resolve("different-real-directory"));

    await expect(SafeSpreadsheetDirectory.open(requested)).rejects.toMatchObject({
      code: "SPREADSHEET_PARSE_FAILED",
    });
    expect(fsMocks.opendir).not.toHaveBeenCalled();
  });

  test("streams directory entries and fails closed above the scan-session limit", async () => {
    const requested = path.resolve("scan");
    const directoryStats = fakeStats({ directory: true, dev: 4, ino: 8 });
    const directoryHandle = fakeDirectoryHandle(directoryStats);
    fsMocks.realpath.mockResolvedValue(requested);
    fsMocks.lstat.mockResolvedValue(directoryStats);
    fsMocks.open.mockResolvedValue(directoryHandle);
    const close = vi.fn(async () => undefined);
    fsMocks.opendir.mockResolvedValue({
      close,
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index <= MAX_SCAN_DIRECTORY_ENTRIES; index += 1) {
          yield { name: `unrelated-${index}.txt` };
        }
      },
    });

    const session = await SafeSpreadsheetDirectory.open(requested);
    await expect(session.listSpreadsheetFiles()).rejects.toMatchObject({
      code: "SPREADSHEET_PARSE_FAILED",
    });
    expect(close).toHaveBeenCalledOnce();
    await session.close();
    if (process.platform === "linux") {
      expect(directoryHandle.close).toHaveBeenCalledOnce();
    }
  });

  test("closes a newly opened child session when the parent identity post-check fails", async () => {
    const parentStats = fakeStats({ directory: true, dev: 1, ino: 10 });
    const childStats = fakeStats({ directory: true, dev: 1, ino: 20 });
    const replacedParent = fakeStats({ directory: true, dev: 1, ino: 11 });
    fsMocks.lstat
      .mockResolvedValueOnce(parentStats)
      .mockResolvedValueOnce(childStats)
      .mockResolvedValueOnce(replacedParent);
    const child = { close: vi.fn(async () => undefined) };
    const openChild = vi
      .spyOn(SafeSpreadsheetDirectory as any, "openKnownDirectory")
      .mockResolvedValueOnce(child);
    const parent = new (SafeSpreadsheetDirectory as any)(
      path.resolve("scan"),
      path.resolve("scan"),
      parentStats,
      null,
    ) as SafeSpreadsheetDirectory;

    await expect(parent.openSubdirectory("maintenance")).rejects.toMatchObject({
      code: "SPREADSHEET_PARSE_FAILED",
    });
    expect(child.close).toHaveBeenCalledOnce();
    openChild.mockRestore();
  });
});
