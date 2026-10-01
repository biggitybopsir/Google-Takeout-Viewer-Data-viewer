import type { GoogleDriveCategory, GoogleDriveFile, GoogleDriveFolder, GoogleDriveSummary, GoogleDriveType, GoogleParserProgress, GoogleRankedItem } from "@/platforms/google/types";
import type { GoogleZipEntry } from "@/platforms/google/parser/archive-index";

const LARGEST_LIMIT = 100;
const TYPE_LIMIT = 12;
const FOLDER_LIMIT = 12;

type CategoryRule = { key: string; label: string; extensions: string[] };

// Order matters only for the chart; each extension belongs to one category.
const CATEGORIES: CategoryRule[] = [
  { key: "video", label: "Video", extensions: [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".3gp"] },
  { key: "archives", label: "Archives", extensions: [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"] },
  { key: "images", label: "Images", extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".svg", ".tif", ".tiff", ".raw"] },
  { key: "audio", label: "Audio", extensions: [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac", ".opus"] },
  { key: "documents", label: "Documents", extensions: [".pdf", ".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".gdoc"] },
  { key: "spreadsheets", label: "Spreadsheets", extensions: [".xls", ".xlsx", ".ods", ".csv", ".tsv", ".gsheet"] },
  { key: "presentations", label: "Presentations", extensions: [".ppt", ".pptx", ".odp", ".key", ".gslides"] },
  { key: "code", label: "Code and data", extensions: [".json", ".js", ".ts", ".py", ".html", ".css", ".xml", ".sql", ".db", ".sqlite", ".yml", ".yaml", ".java", ".lua"] },
];
const OTHER: Pick<CategoryRule, "key" | "label"> = { key: "other", label: "Other" };
const CATEGORY_BY_EXTENSION = new Map(CATEGORIES.flatMap((rule) => rule.extensions.map((extension) => [extension, rule.key] as const)));

function takeoutParts(entry: GoogleZipEntry): string[] {
  const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return index >= 0 ? parts.slice(index + 1) : parts;
}

export function isDriveFile(entry: GoogleZipEntry): boolean {
  const parts = takeoutParts(entry);
  return parts[0] === "Drive" && parts.length >= 2;
}

function toFile(entry: GoogleZipEntry): GoogleDriveFile {
  const parts = takeoutParts(entry).slice(1);
  const name = parts[parts.length - 1] ?? entry.fileName;
  const category = CATEGORY_BY_EXTENSION.get(entry.extension) ?? OTHER.key;
  return {
    path: parts.join("/"),
    name,
    folder: parts.slice(0, -1).join("/"),
    extension: entry.extension || "(none)",
    category,
    bytes: entry.uncompressedSize,
    modified: entry.modified,
    archive: category === "archives",
  };
}

export async function parseDrive(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void): Promise<GoogleDriveSummary | undefined> {
  const files = entries.filter(isDriveFile).map(toFile);
  if (!files.length) return undefined;
  progress?.({ stage: "extracting", label: "Summarising Drive files", percent: 86 });

  const categories = new Map<string, GoogleDriveCategory>();
  const types = new Map<string, GoogleDriveType>();
  const folders = new Map<string, GoogleDriveFolder>();
  const years = new Map<string, number>();
  const folderPaths = new Set<string>();
  const archives = { files: 0, bytes: 0 };
  let totalBytes = 0;
  let start: string | undefined;
  let end: string | undefined;

  for (const file of files) {
    totalBytes += file.bytes;
    const rule = CATEGORIES.find((candidate) => candidate.key === file.category) ?? OTHER;
    const category = categories.get(rule.key) ?? { key: rule.key, label: rule.label, files: 0, bytes: 0 };
    category.files += 1;
    category.bytes += file.bytes;
    categories.set(rule.key, category);

    const type = types.get(file.extension) ?? { extension: file.extension, files: 0, bytes: 0 };
    type.files += 1;
    type.bytes += file.bytes;
    types.set(file.extension, type);

    // Size is credited to the top-level folder so a deep tree still reads as a handful of rows.
    const top = file.folder.split("/")[0] ?? "";
    const folder = folders.get(top) ?? { path: top, files: 0, bytes: 0 };
    folder.files += 1;
    folder.bytes += file.bytes;
    folders.set(top, folder);
    if (file.folder) {
      const segments = file.folder.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) folderPaths.add(segments.slice(0, depth).join("/"));
    }

    if (file.archive) {
      archives.files += 1;
      archives.bytes += file.bytes;
    }
    if (file.modified) {
      years.set(file.modified.slice(0, 4), (years.get(file.modified.slice(0, 4)) ?? 0) + 1);
      if (!start || file.modified < start) start = file.modified;
      if (!end || file.modified > end) end = file.modified;
    }
  }

  const sortedFiles = [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const byYear: GoogleRankedItem[] = [...years.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));

  return {
    files: files.length,
    folders: folderPaths.size,
    totalBytes,
    dateRange: start && end ? { start, end } : undefined,
    byCategory: [...categories.values()].sort((a, b) => b.bytes - a.bytes),
    byType: [...types.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files || a.extension.localeCompare(b.extension)).slice(0, TYPE_LIMIT),
    byYear,
    byFolder: [...folders.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, FOLDER_LIMIT),
    archives,
    largestFiles: sortedFiles.slice(0, LARGEST_LIMIT),
    largestLimit: LARGEST_LIMIT,
    isLargestCapped: files.length > LARGEST_LIMIT,
  };
}
