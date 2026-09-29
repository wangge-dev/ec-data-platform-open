import { constants } from "node:fs";
import path from "node:path";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";

import {
  SPREADSHEET_LIMITS,
  SpreadsheetSecurityError,
} from "./spreadsheet-security.js";

type FileIdentity = {
  dev: number | bigint;
  ino: number | bigint;
};

export const MAX_SCAN_DIRECTORY_ENTRIES = 1024;
const SPREADSHEET_FILE_PATTERN = /\.(xlsx|xls|csv)$/i;

function unsafeFile(message: string): SpreadsheetSecurityError {
  return new SpreadsheetSecurityError("SPREADSHEET_PARSE_FAILED", message);
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function preserveSecurityError(error: unknown, fallback: string): never {
  if (error instanceof SpreadsheetSecurityError) throw error;
  throw unsafeFile(fallback);
}

/**
 * Reads at most the parser's input budget from a regular file without following
 * a final-component symlink.  The pre-open and post-open identities close the
 * usual lstat/open replacement race; the fixed-size read buffer also prevents a
 * file that grows after stat from escaping the byte limit.
 */
export async function readSpreadsheetFileSafely(filePath: string): Promise<Buffer> {
  const maxBytes = SPREADSHEET_LIMITS.maxInputBytes;
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    preserveSecurityError(error, "表格文件不可安全读取");
  }

  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeFile("表格文件必须是普通文件且不能是符号链接");
  }
  if (before.size > maxBytes) {
    throw new SpreadsheetSecurityError(
      "SPREADSHEET_TOO_LARGE",
      `表格文件超过 ${maxBytes / 1024 / 1024}MB 安全上限`,
    );
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    preserveSecurityError(error, "表格文件不可安全打开");
  }

  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameFile(before, after)) {
      throw unsafeFile("表格文件在读取前已发生替换");
    }
    if (after.size > maxBytes) {
      throw new SpreadsheetSecurityError(
        "SPREADSHEET_TOO_LARGE",
        `表格文件超过 ${maxBytes / 1024 / 1024}MB 安全上限`,
      );
    }

    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new SpreadsheetSecurityError(
        "SPREADSHEET_TOO_LARGE",
        `表格文件超过 ${maxBytes / 1024 / 1024}MB 安全上限`,
      );
    }
    // Copy the exact payload so a small file does not retain the 30MB guard buffer.
    return Buffer.from(bounded.subarray(0, offset));
  } catch (error) {
    preserveSecurityError(error, "表格文件不可安全读取");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function normalizedPathForComparison(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertLeafName(name: string): void {
  if (
    !name
    || name === "."
    || name === ".."
    || path.basename(name) !== name
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
  ) {
    throw unsafeFile("扫描目录包含非法文件名");
  }
}

async function directoryIdentity(directory: string): Promise<FileIdentity & {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeFile("扫描路径不是可安全读取的真实目录");
  }
  return stats;
}

/**
 * A bounded scan session.  On Linux the session holds an O_DIRECTORY|
 * O_NOFOLLOW descriptor and all children are addressed through /proc/self/fd,
 * so renaming/replacing the configured path cannot redirect later reads.  On
 * Windows, where Node does not expose openat, realpath rejects ancestor
 * junctions and the captured directory identity is checked before and after
 * every enumeration/read.
 */
export class SafeSpreadsheetDirectory {
  private constructor(
    private readonly physicalPath: string,
    private readonly accessPath: string,
    private readonly identity: FileIdentity,
    private readonly handle: FileHandle | null,
  ) {}

  static async open(directory: string): Promise<SafeSpreadsheetDirectory> {
    const requested = path.resolve(directory);
    let canonical: string;
    try {
      canonical = await realpath(requested);
    } catch (error) {
      preserveSecurityError(error, "扫描目录不可安全解析");
    }
    if (
      normalizedPathForComparison(canonical)
      !== normalizedPathForComparison(requested)
    ) {
      throw unsafeFile("扫描目录不能包含符号链接或目录联接");
    }
    return SafeSpreadsheetDirectory.openKnownDirectory(canonical, canonical);
  }

  private static async openKnownDirectory(
    physicalPath: string,
    accessPath: string,
  ): Promise<SafeSpreadsheetDirectory> {
    let before;
    try {
      before = await directoryIdentity(accessPath);
    } catch (error) {
      preserveSecurityError(error, "扫描目录不可安全读取");
    }

    if (process.platform !== "linux") {
      return new SafeSpreadsheetDirectory(
        physicalPath,
        accessPath,
        before,
        null,
      );
    }

    const directoryOnly = constants.O_DIRECTORY;
    const noFollow = constants.O_NOFOLLOW;
    if (typeof directoryOnly !== "number" || typeof noFollow !== "number") {
      throw unsafeFile("当前系统不支持安全目录句柄");
    }
    let handle: FileHandle;
    try {
      handle = await open(
        accessPath,
        constants.O_RDONLY | directoryOnly | noFollow,
      );
    } catch (error) {
      preserveSecurityError(error, "扫描目录不可安全打开");
    }
    try {
      const after = await handle.stat();
      if (!after.isDirectory() || !sameFile(before, after)) {
        throw unsafeFile("扫描目录在打开前已发生替换");
      }
      return new SafeSpreadsheetDirectory(
        physicalPath,
        `/proc/self/fd/${handle.fd}`,
        before,
        handle,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      preserveSecurityError(error, "扫描目录不可安全打开");
    }
  }

  private async assertIdentity(): Promise<void> {
    try {
      const current = await directoryIdentity(this.physicalPath);
      if (!sameFile(this.identity, current)) {
        throw unsafeFile("扫描目录在处理期间已发生替换");
      }
      if (this.handle) {
        const held = await this.handle.stat();
        if (!held.isDirectory() || !sameFile(this.identity, held)) {
          throw unsafeFile("扫描目录句柄已失效");
        }
      }
    } catch (error) {
      preserveSecurityError(error, "扫描目录在处理期间不可安全读取");
    }
  }

  async listSpreadsheetFiles(): Promise<string[]> {
    await this.assertIdentity();
    const names: string[] = [];
    let entries = 0;
    let directory;
    try {
      directory = await opendir(this.accessPath);
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_SCAN_DIRECTORY_ENTRIES) {
          throw unsafeFile(
            `扫描目录条目数超过安全上限 ${MAX_SCAN_DIRECTORY_ENTRIES}`,
          );
        }
        if (!SPREADSHEET_FILE_PATTERN.test(entry.name) || entry.name.startsWith("~$")) {
          continue;
        }
        assertLeafName(entry.name);
        const stats = await lstat(path.join(this.accessPath, entry.name));
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw unsafeFile("扫描目录中的表格必须是普通文件且不能是符号链接");
        }
        names.push(entry.name);
      }
    } catch (error) {
      preserveSecurityError(error, "扫描目录枚举失败");
    } finally {
      await directory?.close().catch(() => undefined);
    }
    await this.assertIdentity();
    return names.sort((left, right) => left.localeCompare(right));
  }

  async openSubdirectory(name: string): Promise<SafeSpreadsheetDirectory | null> {
    assertLeafName(name);
    await this.assertIdentity();
    const childAccessPath = path.join(this.accessPath, name);
    const childPhysicalPath = path.join(this.physicalPath, name);
    try {
      await lstat(childAccessPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      preserveSecurityError(error, "扫描子目录不可安全读取");
    }
    let child: SafeSpreadsheetDirectory | null = null;
    try {
      child = await SafeSpreadsheetDirectory.openKnownDirectory(
        childPhysicalPath,
        childAccessPath,
      );
      await this.assertIdentity();
      return child;
    } catch (error) {
      await child?.close();
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw error;
    }
  }

  async readFile(name: string): Promise<Buffer> {
    assertLeafName(name);
    await this.assertIdentity();
    const bytes = await readSpreadsheetFileSafely(path.join(this.accessPath, name));
    await this.assertIdentity();
    return bytes;
  }

  async close(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
  }
}
