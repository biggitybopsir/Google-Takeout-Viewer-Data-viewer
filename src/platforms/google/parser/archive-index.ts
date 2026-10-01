import { Inflate, inflateSync, strFromU8 } from "fflate";
import type { GoogleCoverageStatus } from "@/platforms/google/types";

const decoder = new TextDecoder();

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP_TAIL_BYTES = 66_000;
const STREAM_CHUNK_BYTES = 1024 * 1024;
// Typical local extra field (timestamps, ZIP64 sizes) is well under this; if not, the read is simply repeated exactly.
const LOCAL_EXTRA_GUESS_BYTES = 128;
const ENTRY_READ_WINDOW = 32;

export type GoogleZipEntry = {
  path: string;
  fileName: string;
  product: string;
  sourceArchive: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  encrypted: boolean;
  /** CRC-32 of the uncompressed data, from the central directory (the local header can hold zeros when a data descriptor is used). */
  crc32: number;
  localOffset: number;
  extension: string;
  /** Last-modified date from the ZIP central directory (YYYY-MM-DD, the clock Google wrote, no time zone). */
  modified?: string;
  status: GoogleCoverageStatus;
  reason?: string;
  file: File;
};

export type GoogleIndexedArchive = {
  fileName: string;
  size: number;
  entries: GoogleZipEntry[];
  warnings: string[];
};

async function readSlice(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function readUint64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true));
}

function normalizePath(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

function basename(name: string): string {
  return normalizePath(name).split("/").pop() ?? normalizePath(name);
}

function extension(name: string): string {
  const base = basename(name).toLowerCase();
  const index = base.lastIndexOf(".");
  return index === -1 ? "" : base.slice(index);
}

function productFromPath(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const takeoutIndex = parts.findIndex((part) => part.toLowerCase() === "takeout");
  const product = takeoutIndex >= 0 ? parts[takeoutIndex + 1] : parts[0];
  return product || "Unknown";
}

function dosDate(value: number): string | undefined {
  const year = ((value >> 9) & 0x7f) + 1980;
  const month = (value >> 5) & 0xf;
  const day = value & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseZip64Extra(extra: Uint8Array, needs: { uncompressedSize: boolean; compressedSize: boolean; localOffset: boolean }) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const headerId = view.getUint16(offset, true);
    const dataSize = view.getUint16(offset + 2, true);
    const dataOffset = offset + 4;
    if (headerId === ZIP64_EXTRA_FIELD_ID) {
      let cursor = dataOffset;
      const values: { uncompressedSize?: number; compressedSize?: number; localOffset?: number } = {};
      if (needs.uncompressedSize && cursor + 8 <= dataOffset + dataSize) {
        values.uncompressedSize = readUint64(view, cursor);
        cursor += 8;
      }
      if (needs.compressedSize && cursor + 8 <= dataOffset + dataSize) {
        values.compressedSize = readUint64(view, cursor);
        cursor += 8;
      }
      if (needs.localOffset && cursor + 8 <= dataOffset + dataSize) values.localOffset = readUint64(view, cursor);
      return values;
    }
    offset = dataOffset + dataSize;
  }
  return {};
}

async function locateCentralDirectory(file: File): Promise<{ offset: number; size: number }> {
  const tailStart = Math.max(0, file.size - ZIP_TAIL_BYTES);
  const tail = await readSlice(file, tailStart, file.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocdOffset = -1;
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === EOCD_SIGNATURE) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("This ZIP file could not be indexed. It may be damaged or only partly downloaded, so download it again from Google.");

  const centralEntries = view.getUint16(eocdOffset + 10, true);
  let centralSize = view.getUint32(eocdOffset + 12, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const needsZip64 = centralEntries === ZIP_UINT16_MAX || centralSize === ZIP_UINT32_MAX || centralOffset === ZIP_UINT32_MAX;

  if (needsZip64) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || view.getUint32(locatorOffset, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error("This ZIP uses ZIP64 metadata that could not be located.");
    }
    const zip64Offset = readUint64(view, locatorOffset + 8);
    const zip64Header = await readSlice(file, zip64Offset, zip64Offset + 56);
    const zip64View = new DataView(zip64Header.buffer, zip64Header.byteOffset, zip64Header.byteLength);
    if (zip64View.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error("This ZIP uses ZIP64 metadata that could not be read.");
    }
    centralSize = readUint64(zip64View, 40);
    centralOffset = readUint64(zip64View, 48);
  }

  return { offset: centralOffset, size: centralSize };
}

export async function indexGoogleZip(file: File): Promise<GoogleIndexedArchive> {
  const warnings: string[] = [];
  const centralDirectory = await locateCentralDirectory(file);
  const directoryBytes = await readSlice(file, centralDirectory.offset, centralDirectory.offset + centralDirectory.size);
  const directoryView = new DataView(directoryBytes.buffer, directoryBytes.byteOffset, directoryBytes.byteLength);
  const entries: GoogleZipEntry[] = [];

  let offset = 0;
  while (offset + 46 <= directoryBytes.byteLength) {
    if (directoryView.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      warnings.push(`Stopped reading ${file.name} after ${entries.length} entries because the central directory ended unexpectedly.`);
      break;
    }
    const flags = directoryView.getUint16(offset + 8, true);
    const compressionMethod = directoryView.getUint16(offset + 10, true);
    const crc32 = directoryView.getUint32(offset + 16, true);
    let compressedSize = directoryView.getUint32(offset + 20, true);
    let uncompressedSize = directoryView.getUint32(offset + 24, true);
    const fileNameLength = directoryView.getUint16(offset + 28, true);
    const extraLength = directoryView.getUint16(offset + 30, true);
    const commentLength = directoryView.getUint16(offset + 32, true);
    let localOffset = directoryView.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    const extraStart = nameEnd;
    const extraEnd = extraStart + extraLength;
    if (nameEnd > directoryBytes.byteLength || extraEnd > directoryBytes.byteLength) {
      warnings.push(`Skipped a truncated central-directory entry in ${file.name}.`);
      break;
    }

    const path = normalizePath(decoder.decode(directoryBytes.slice(nameStart, nameEnd)));
    if (compressedSize === ZIP_UINT32_MAX || uncompressedSize === ZIP_UINT32_MAX || localOffset === ZIP_UINT32_MAX) {
      const zip64 = parseZip64Extra(directoryBytes.slice(extraStart, extraEnd), {
        uncompressedSize: uncompressedSize === ZIP_UINT32_MAX,
        compressedSize: compressedSize === ZIP_UINT32_MAX,
        localOffset: localOffset === ZIP_UINT32_MAX,
      });
      compressedSize = zip64.compressedSize ?? compressedSize;
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
      localOffset = zip64.localOffset ?? localOffset;
    }

    if (!path.endsWith("/")) {
      entries.push({
        path,
        fileName: basename(path),
        product: productFromPath(path),
        sourceArchive: file.name,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        encrypted: Boolean(flags & 1),
        crc32,
        localOffset,
        extension: extension(path),
        modified: dosDate(directoryView.getUint16(offset + 14, true)),
        status: "indexed",
        file,
      });
    }
    offset = extraEnd + commentLength;
  }

  return { fileName: file.name, size: file.size, entries, warnings };
}

export async function readGoogleZipEntryText(entry: GoogleZipEntry): Promise<string> {
  if (entry.encrypted) throw new Error("Encrypted ZIP entries are not supported.");
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}.`);
  }
  // One read for the local header and the data together. Each separate read of a large file is slow on a phone (an Android
  // file picker hands the browser a handle that costs a round trip per read), so the usual header plus extra-field size is
  // guessed from the name and the exact size is checked afterwards; a longer extra field falls back to a second read.
  const guessedHeader = 30 + new TextEncoder().encode(entry.path).length + LOCAL_EXTRA_GUESS_BYTES;
  const first = await readSlice(entry.file, entry.localOffset, Math.min(entry.file.size, entry.localOffset + guessedHeader + entry.compressedSize));
  const localView = new DataView(first.buffer, first.byteOffset, first.byteLength);
  if (first.byteLength < 30 || localView.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) throw new Error("Could not read the local ZIP file header.");
  const headerLength = 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
  const compressed = headerLength + entry.compressedSize <= first.byteLength
    ? first.subarray(headerLength, headerLength + entry.compressedSize)
    : await readSlice(entry.file, entry.localOffset + headerLength, entry.localOffset + headerLength + entry.compressedSize);
  const bytes = entry.compressionMethod === 0 ? compressed : inflateSync(compressed);
  return strFromU8(bytes);
}

/**
 * Reads entries in the order they will be used while keeping a few reads in flight ahead of the caller, so a long run of
 * small files (thousands of Photos sidecars) is not paid for one slow read at a time. Memory is bounded by the window.
 */
export function createEntryReader(entries: GoogleZipEntry[], windowSize = ENTRY_READ_WINDOW): { read: (entry: GoogleZipEntry) => Promise<string> } {
  const position = new Map(entries.map((entry, index) => [entry, index] as const));
  const pending = new Map<GoogleZipEntry, Promise<string>>();
  const start = (index: number) => {
    const entry = entries[index];
    if (!entry || pending.has(entry)) return;
    const promise = readGoogleZipEntryText(entry);
    promise.catch(() => undefined);
    pending.set(entry, promise);
  };
  return {
    read(entry) {
      const index = position.get(entry);
      if (index !== undefined) for (let ahead = 0; ahead < windowSize; ahead += 1) start(index + ahead);
      const promise = pending.get(entry) ?? readGoogleZipEntryText(entry);
      pending.delete(entry);
      return promise;
    },
  };
}

async function entryDataStart(entry: GoogleZipEntry): Promise<number> {
  const localHeader = await readSlice(entry.file, entry.localOffset, entry.localOffset + 30);
  const localView = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
  if (localView.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) throw new Error("Could not read the local ZIP file header.");
  return entry.localOffset + 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
}

// Inflates an entry in pieces so very large files (a multi-GB Gmail mbox) never sit in memory whole.
// onChunk receives each piece of uncompressed bytes synchronously; onProgress gets compressed bytes consumed.
export async function streamGoogleZipEntry(
  entry: GoogleZipEntry,
  onChunk: (chunk: Uint8Array) => void,
  onProgress?: (consumed: number, total: number) => void,
): Promise<void> {
  if (entry.encrypted) throw new Error("Encrypted ZIP entries are not supported.");
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}.`);
  }
  const dataStart = await entryDataStart(entry);
  const inflater = entry.compressionMethod === 8 ? new Inflate((chunk) => onChunk(chunk)) : undefined;
  for (let offset = 0; offset < entry.compressedSize; offset += STREAM_CHUNK_BYTES) {
    const end = Math.min(offset + STREAM_CHUNK_BYTES, entry.compressedSize);
    const slice = await readSlice(entry.file, dataStart + offset, dataStart + end);
    if (inflater) inflater.push(slice, end >= entry.compressedSize);
    else onChunk(slice);
    onProgress?.(end, entry.compressedSize);
  }
  if (inflater && entry.compressedSize === 0) inflater.push(new Uint8Array(0), true);
}
