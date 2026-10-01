import type {
  GoogleActivityEntry,
  GoogleActivityServiceSummary,
  GoogleActivitySummary,
  GoogleChromeDevice,
  GoogleChromeHistoryEntry,
  GoogleChromeHistorySummary,
  GoogleCoverageStatus,
  GoogleDayCount,
  GoogleFitSummary,
  GoogleSectionKey,
  GoogleSectionResult,
  GoogleGeminiSummary,
  GoogleDriveSummary,
  GooglePlayGamesSummary,
  GoogleMailSummary,
  GoogleParserError,
  GoogleMoreServices,
  GoogleParserProgress,
  GooglePhotosEntry,
  GooglePhotosSummary,
  GooglePlayInstall,
  GooglePlayPurchase,
  GooglePlaySpend,
  GooglePlaySubscription,
  GooglePlayDevice,
  GooglePlaySummary,
  GoogleProductSummary,
  GoogleRankedItem,
  GoogleServiceAvailability,
  GoogleUnpackedData,
} from "@/platforms/google/types";
import { DEFERRABLE_SECTIONS, SERVICE_LABELS, fitServiceCard, mailServiceCard, photosServiceCard } from "@/platforms/google/sections";
import { createEntryReader, indexGoogleZip, readGoogleZipEntryText, type GoogleIndexedArchive, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import { isFitFile, parseFit } from "@/platforms/google/parser/fit";
import { isGeminiActivityFile, parseGemini } from "@/platforms/google/parser/gemini";
import { isPlayGamesFile, parsePlayGames } from "@/platforms/google/parser/play-games";
import { isMailFile, parseMail } from "@/platforms/google/parser/mail";
import { parseDrive } from "@/platforms/google/parser/drive";
import { isSmallServiceFile, parseSmallServices } from "@/platforms/google/parser/small-services";
import { parseYouTubeHistoryTexts } from "@/platforms/youtube/parser/parse-youtube-export";
import type { YouTubeUnpackedData } from "@/platforms/youtube/types";
import { cleanLine, decodeHtmlEntities, HTML_DATE_RE, htmlDateToIso, stableId, stripTags } from "@/platforms/google/parser/html";

type ProgressCallback = (progress: GoogleParserProgress) => void;

const ACTIVITY_RECENT_LIMIT = 2_000;
const CHROME_RECENT_LIMIT = 2_000;
const CHROME_DEVICE_LIMIT = 12;
const PHOTOS_RECENT_LIMIT = 2_000;
const PLAY_LIST_LIMIT = 2_000;
const LARGEST_FILE_LIMIT = 80;
const TOP_LIMIT = 15;

const TARGET_ACTIVITY_SERVICES = new Set([
  "Search",
  "Chrome",
  "YouTube",
  "Image Search",
  "Maps",
  "Google Play Store",
  "Assistant",
  "Discover",
  "Google Play Games",
  "Shopping",
  "Video Search",
  "Help",
  "Google Lens",
  "Google Translate",
  "Song Search",
  "Google Play Books",
  "Google Play Movies & TV",
  "Books",
  "Flights",
  "Hotels",
  "Ads",
  "Android",
  "AI Mode",
  "Developers",
  "Google News",
  "Google Business Profile",
  "Takeout",
  "Drive",
]);

const MEDIA_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".m4a"]);

const HTML_OUTER_CELL_MARKER = '<div class="outer-cell';
const HTML_ANCHOR_RE = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const HTML_CONTENT_CELL_RE = /<div class="content-cell([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi;

function fail(message: string, fileName?: string): never {
  throw { fileName, message } satisfies GoogleParserError;
}

function update(progress: ProgressCallback | undefined, progressValue: GoogleParserProgress) {
  progress?.(progressValue);
}

function formatPercent(done: number, total: number, start: number, span: number): number {
  if (!total) return start + span;
  return Math.min(99, Math.round((start + (done / total) * span) * 10) / 10);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function relativeTakeoutPath(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const takeoutIndex = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return takeoutIndex >= 0 ? parts.slice(takeoutIndex + 1).join("/") : parts.join("/");
}

function pathParts(entry: GoogleZipEntry): string[] {
  return relativeTakeoutPath(entry.path).split("/").filter(Boolean);
}

function activityService(entry: GoogleZipEntry): string | undefined {
  const parts = pathParts(entry);
  if (parts[0] !== "My Activity") return undefined;
  return parts[1];
}

function isActivityFile(entry: GoogleZipEntry): boolean {
  const service = activityService(entry);
  if (!service || !TARGET_ACTIVITY_SERVICES.has(service)) return false;
  const fileName = entry.fileName.toLowerCase();
  return fileName === "my activity.html" || fileName === "myactivity.html" || fileName === "my activity.json" || fileName === "myactivity.json";
}

function isChromeHistoryFile(entry: GoogleZipEntry): boolean {
  if (entry.product !== "Chrome") return false;
  const fileName = entry.fileName.toLowerCase();
  return fileName === "history.json" || fileName === "browserhistory.json";
}

function isChromeDeviceFile(entry: GoogleZipEntry): boolean {
  return entry.product === "Chrome" && entry.fileName.toLowerCase() === "device information.json";
}

function isYouTubeHistoryFile(entry: GoogleZipEntry): boolean {
  if (entry.product !== "YouTube and YouTube Music") return false;
  const parts = pathParts(entry).map((part) => part.toLowerCase());
  if (!parts.includes("history")) return false;
  const fileName = entry.fileName.toLowerCase();
  return fileName === "watch-history.json" || fileName === "watch-history.html" || fileName === "search-history.json" || fileName === "search-history.html";
}

const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff", ".dng", ".raw", ".arw", ".cr2", ".nef"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".3gp", ".m4v", ".webm", ".mpg", ".mpeg", ".mts", ".wmv"]);
const PHOTOS_NON_SIDECAR_JSON = new Set(["metadata.json", "shared_album_comments.json", "print-subscriptions.json", "user-generated-memory-titles.json"]);
const PHOTOS_YEAR_FOLDER_RE = /^Photos from \d{4}$/i;

function isPhotosSidecarFile(entry: GoogleZipEntry): boolean {
  if (entry.product !== "Google Photos") return false;
  const fileName = entry.fileName.toLowerCase();
  if (!fileName.endsWith(".json") || PHOTOS_NON_SIDECAR_JSON.has(fileName)) return false;
  // "IMG.jpg.supplemental-metadata.json", its truncated variants, and the older "IMG.jpg.json".
  // Takeout appends "(1)" to duplicate names, e.g. "IMG.jpg.supplemental-metadata(1).json".
  return /\.su[a-z-]*(\(\d+\))?\.json$/.test(fileName) || /\.[a-z0-9]{2,5}(\(\d+\))?\.json$/.test(fileName);
}

function isPhotosCommentsFile(entry: GoogleZipEntry): boolean {
  return entry.product === "Google Photos" && entry.fileName.toLowerCase() === "shared_album_comments.json";
}

function classifyEntry(entry: GoogleZipEntry): { status: GoogleCoverageStatus; reason?: string } {
  if (entry.encrypted) return { status: "unsupported", reason: "Encrypted ZIP entry" };
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) return { status: "unsupported", reason: `Unsupported compression method ${entry.compressionMethod}` };
  if (isActivityFile(entry)) return { status: "parsed", reason: "Parsed by the My Activity MVP" };
  if (isChromeHistoryFile(entry) || isChromeDeviceFile(entry)) return { status: "parsed", reason: "Parsed by the Chrome History tab" };
  if (isYouTubeHistoryFile(entry)) return { status: "parsed", reason: "Parsed by the YouTube tab" };
  if (isSmallServiceFile(entry)) return { status: "parsed", reason: "Parsed by the More services tab" };
  if (isMailFile(entry)) return { status: "parsed", reason: "Parsed by the Gmail tab (headers only)" };
  if (isFitFile(entry)) return { status: "parsed", reason: "Parsed by the Fit tab" };
  if (isGeminiActivityFile(entry)) return { status: "parsed", reason: "Parsed by the Gemini tab" };
  if (isPlayGamesFile(entry)) return { status: "parsed", reason: "Parsed by the Play Games tab" };
  if (isPlayStoreFile(entry)) return { status: "parsed", reason: "Parsed by the Play Store tab" };
  if (isPhotosSidecarFile(entry)) return { status: "parsed", reason: "Parsed by the Photos metadata tab" };
  if (entry.product === "Google Photos" && !entry.fileName.toLowerCase().endsWith(".json")) return { status: "deferred", reason: "Photos media is deferred" };
  if (entry.product === "Drive") return { status: "deferred", reason: "Drive file contents are deferred" };
  if (entry.product === "Mail" && entry.extension === ".mbox") return { status: "deferred", reason: "Gmail mbox parsing is deferred" };
  if (MEDIA_EXTS.has(entry.extension)) return { status: "deferred", reason: "Binary media is deferred" };
  return { status: "indexed", reason: "Indexed for coverage" };
}

function increment(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function rankedFromCounts(map: Map<string, number>, limit = TOP_LIMIT): GoogleRankedItem[] {
  return [...map.entries()]
    .filter(([label]) => label.length > 0)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function weekKey(date: Date): string {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayOffset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - isoDayOffset);
  return monday.toISOString().slice(0, 10);
}

function dateCounts(dates: Date[], limit: number): GoogleDayCount[] {
  const counts = new Map<string, number>();
  for (const date of dates) increment(counts, dayKey(date));
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);
}

function chronologicalRanked(counts: Map<string, number>, limit: number): GoogleRankedItem[] {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-limit);
}

function busiestDay(dates: Date[]): GoogleDayCount | undefined {
  return dateCounts(dates, Number.MAX_SAFE_INTEGER).sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))[0];
}

function longestStreak(dates: Date[]): { days: number; startDate: string; endDate: string } | undefined {
  const uniqueDays = [...new Set(dates.map(dayKey))].sort();
  if (!uniqueDays.length) return undefined;
  let bestStart = uniqueDays[0];
  let bestEnd = uniqueDays[0];
  let bestLength = 1;
  let runStart = uniqueDays[0];
  let runLength = 1;

  for (let i = 1; i < uniqueDays.length; i += 1) {
    const previous = new Date(`${uniqueDays[i - 1]}T00:00:00.000Z`);
    const current = new Date(`${uniqueDays[i]}T00:00:00.000Z`);
    const gap = Math.round((current.getTime() - previous.getTime()) / 86_400_000);
    if (gap === 1) {
      runLength += 1;
    } else {
      runStart = uniqueDays[i];
      runLength = 1;
    }
    if (runLength > bestLength) {
      bestLength = runLength;
      bestStart = runStart;
      bestEnd = uniqueDays[i];
    }
  }
  return { days: bestLength, startDate: bestStart, endDate: bestEnd };
}

function hostFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(decodeHtmlEntities(url)).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function chromeUsecToIso(value: unknown): string | undefined {
  const usec = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(usec) || usec <= 0) return undefined;
  const date = new Date(Math.floor(usec / 1000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseAnchors(html: string): { url: string; text: string }[] {
  const anchors: { url: string; text: string }[] = [];
  HTML_ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_ANCHOR_RE.exec(html))) {
    anchors.push({ url: decodeHtmlEntities(match[1]), text: cleanLine(stripTags(match[2])) });
  }
  return anchors;
}

function splitHtmlEntries(html: string): string[] {
  return html.split(HTML_OUTER_CELL_MARKER).slice(1);
}

function parseCaption(captionHtml: string): { products: string[]; detailCount: number; hasLocation: boolean } {
  const products: string[] = [];
  const productMatch = /<b>\s*Products:\s*<\/b>([\s\S]*?)(?:<b>|$)/i.exec(captionHtml);
  if (productMatch) {
    for (const line of stripTags(productMatch[1]).split("\n").map(cleanLine)) {
      if (line) products.push(line);
    }
  }
  const detailsMatch = /<b>\s*Details:\s*<\/b>([\s\S]*?)(?:<b>|$)/i.exec(captionHtml);
  const detailCount = detailsMatch ? stripTags(detailsMatch[1]).split("\n").map(cleanLine).filter(Boolean).length : 0;
  return { products, detailCount, hasLocation: /<b>\s*Locations:\s*<\/b>/i.test(captionHtml) };
}

function parseHtmlActivityBlock(chunk: string, service: string, sourcePath: string, index: number): GoogleActivityEntry | undefined {
  const cells: { classes: string; html: string }[] = [];
  HTML_CONTENT_CELL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_CONTENT_CELL_RE.exec(chunk))) {
    cells.push({ classes: match[1], html: match[2] });
  }
  const body = cells.find((cell) => cell.classes.includes("mdl-typography--body-1") && !cell.classes.includes("mdl-typography--text-right"));
  if (!body) return undefined;
  const caption = cells.find((cell) => cell.classes.includes("mdl-typography--caption"));
  const dateMatch = HTML_DATE_RE.exec(body.html);
  const time = dateMatch ? htmlDateToIso(dateMatch) : undefined;
  const anchors = parseAnchors(body.html);
  const lines = stripTags(body.html)
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
  const dateLineIndex = lines.findIndex((line) => HTML_DATE_RE.test(line));
  const textLines = dateLineIndex >= 0 ? lines.slice(0, dateLineIndex) : lines;
  const title = cleanLine(textLines.join(" / "));
  const action = title.split(" ").slice(0, 3).join(" ");
  const firstUrl = anchors[0]?.url;
  const captionInfo = caption ? parseCaption(caption.html) : { products: [], detailCount: 0, hasLocation: false };

  return {
    id: stableId(service, sourcePath, index, time, title),
    service,
    action,
    title,
    url: firstUrl,
    host: hostFromUrl(firstUrl),
    time,
    products: captionInfo.products,
    detailCount: captionInfo.detailCount,
    hasLocation: captionInfo.hasLocation,
    sourcePath,
  };
}

function parseHtmlActivity(text: string, service: string, sourcePath: string): { entries: GoogleActivityEntry[]; malformed: number } {
  const entries: GoogleActivityEntry[] = [];
  let malformed = 0;
  const chunks = splitHtmlEntries(text);
  chunks.forEach((chunk, index) => {
    const entry = parseHtmlActivityBlock(chunk, service, sourcePath, index);
    if (entry) entries.push(entry);
    else malformed += 1;
  });
  return { entries, malformed };
}

function parseJsonActivity(text: string, service: string, sourcePath: string): { entries: GoogleActivityEntry[]; malformed: number } {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [];
  const entries: GoogleActivityEntry[] = [];
  let malformed = 0;
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      malformed += 1;
      return;
    }
    const record = row as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : undefined;
    const url = typeof record.titleUrl === "string" ? record.titleUrl : undefined;
    const time = typeof record.time === "string" ? record.time : undefined;
    const products = Array.isArray(record.products) ? record.products.filter((item): item is string => typeof item === "string") : [];
    const details = Array.isArray(record.details) ? record.details : [];
    const locationInfos = Array.isArray(record.locationInfos) ? record.locationInfos : [];
    entries.push({
      id: stableId(service, sourcePath, index, time, title),
      service,
      action: title?.split(" ").slice(0, 3).join(" "),
      title,
      url,
      host: hostFromUrl(url),
      time,
      products,
      detailCount: details.length,
      hasLocation: locationInfos.length > 0,
      sourcePath,
    });
  });
  return { entries, malformed };
}

async function parseMyActivity(entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<GoogleActivitySummary | undefined> {
  const activityFiles = entries.filter(isActivityFile);
  if (!activityFiles.length) return undefined;

  const allEntries: GoogleActivityEntry[] = [];
  const warnings: string[] = [];
  const serviceSummaries = new Map<string, GoogleActivityServiceSummary>();
  let malformedEntries = 0;

  for (let index = 0; index < activityFiles.length; index += 1) {
    const entry = activityFiles[index];
    const service = activityService(entry) ?? "Unknown";
    update(progress, {
      stage: "parsing",
      label: `Parsing My Activity: ${service}`,
      percent: formatPercent(index, activityFiles.length, 48, 35),
    });
    const summary =
      serviceSummaries.get(service) ??
      ({ service, files: 0, parsedEntries: 0, malformedEntries: 0, bytes: 0, status: "parsed" } satisfies GoogleActivityServiceSummary);
    summary.files += 1;
    summary.bytes += entry.uncompressedSize;

    try {
      const text = await readGoogleZipEntryText(entry);
      const result = entry.fileName.toLowerCase().endsWith(".json")
        ? parseJsonActivity(text, service, entry.path)
        : parseHtmlActivity(text, service, entry.path);
      allEntries.push(...result.entries);
      malformedEntries += result.malformed;
      summary.parsedEntries += result.entries.length;
      summary.malformedEntries += result.malformed;
    } catch (error) {
      summary.status = "malformed";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse this activity file."}`);
    }
    serviceSummaries.set(service, summary);
  }

  update(progress, { stage: "analyzing", label: "Aggregating My Activity", percent: 84 });
  const dates: Date[] = [];
  const groupDates: { other: Date[]; chrome: Date[]; youtube: Date[] } = { other: [], chrome: [], youtube: [] };
  const byService = new Map<string, number>();
  const byHost = new Map<string, number>();
  const byWeek = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byYear = new Map<string, number>();
  const byHour = new Map<string, number>();
  const byWeekday = new Map<string, number>();
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const entry of allEntries) {
    increment(byService, entry.service);
    if (entry.host) increment(byHost, entry.host);
    if (!entry.time) continue;
    const date = new Date(entry.time);
    if (Number.isNaN(date.getTime())) continue;
    dates.push(date);
    (entry.service === "Chrome" ? groupDates.chrome : entry.service === "YouTube" ? groupDates.youtube : groupDates.other).push(date);
    increment(byWeek, weekKey(date));
    increment(byMonth, monthKey(date));
    increment(byYear, String(date.getUTCFullYear()));
    increment(byHour, `${String(date.getUTCHours()).padStart(2, "0")}:00`);
    increment(byWeekday, weekdayLabels[date.getUTCDay()]);
  }

  const recentEntries = [...allEntries]
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .slice(0, ACTIVITY_RECENT_LIMIT);

  return {
    total: allEntries.length,
    parsedFiles: activityFiles.length,
    malformedEntries,
    warnings,
    services: [...serviceSummaries.values()].sort((a, b) => b.parsedEntries - a.parsedEntries || a.service.localeCompare(b.service)),
    byService: rankedFromCounts(byService),
    topHosts: rankedFromCounts(byHost),
    activityByDay: dateCounts(dates, 120),
    daily: { other: dateCounts(groupDates.other, Number.MAX_SAFE_INTEGER), chrome: dateCounts(groupDates.chrome, Number.MAX_SAFE_INTEGER), youtube: dateCounts(groupDates.youtube, Number.MAX_SAFE_INTEGER) },
    activityByWeek: chronologicalRanked(byWeek, 104),
    activityByMonth: chronologicalRanked(byMonth, 72),
    activityByYear: chronologicalRanked(byYear, 20),
    activityByHour: Array.from({ length: 24 }, (_, hour) => {
      const label = `${String(hour).padStart(2, "0")}:00`;
      return { label, count: byHour.get(label) ?? 0 };
    }),
    activityByWeekday: weekdayLabels.map((label) => ({ label, count: byWeekday.get(label) ?? 0 })),
    busiestDay: busiestDay(dates),
    longestActiveStreak: longestStreak(dates),
    recentEntries,
    recentEntryLimit: ACTIVITY_RECENT_LIMIT,
    isEntryListCapped: allEntries.length > ACTIVITY_RECENT_LIMIT,
    timestampWarning: activityFiles.some((entry) => entry.fileName.toLowerCase().endsWith(".html")),
  };
}

type ChromeDeviceInfo = { name: string; platform?: string; chromeVersion?: string };

const CHROME_OS_NAMES: Record<string, string> = { WINDOWS: "Windows", ANDROID: "Android", MAC: "macOS", MACOS: "macOS", LINUX: "Linux", CHROME: "ChromeOS", CHROMEOS: "ChromeOS", IOS: "iOS" };

function tidyMaker(value: string): string {
  return value.length > 3 && value === value.toUpperCase() ? value.charAt(0) + value.slice(1).toLowerCase() : value;
}

// Chrome/Device Information.json lists the signed-in sync devices; its cache_guid is the client_id on History.json rows.
function parseChromeDeviceInfo(parsed: Record<string, unknown>): Map<string, ChromeDeviceInfo> {
  const devices = new Map<string, ChromeDeviceInfo>();
  for (const value of asArray(parsed["Device Info"])) {
    const record = asRecord(value);
    const guid = typeof record?.cache_guid === "string" ? record.cache_guid : undefined;
    if (!record || !guid) continue;
    const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined);
    const maker = text("manufacturer");
    const model = text("model");
    const os = CHROME_OS_NAMES[(text("os_type") ?? "").replace("OS_TYPE_", "")];
    const formFactor = (text("device_form_factor") ?? "").replace("DEVICE_FORM_FACTOR_", "").toLowerCase();
    const major = text("chrome_version")?.split(".")[0];
    devices.set(guid, {
      name: text("server_determined_model_name") ?? ([maker ? tidyMaker(maker) : undefined, model].filter(Boolean).join(" ") || "Unknown device"),
      platform: [os, formFactor && formFactor !== "unspecified" ? formFactor : undefined].filter(Boolean).join(" ") || undefined,
      chromeVersion: major ? `Chrome ${major}` : undefined,
    });
  }
  return devices;
}

async function parseChromeHistory(entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<GoogleChromeHistorySummary | undefined> {
  const historyFiles = entries.filter(isChromeHistoryFile);
  if (!historyFiles.length) return undefined;

  const rows: (GoogleChromeHistoryEntry & { clientId?: string })[] = [];
  const warnings: string[] = [];
  const deviceInfo = new Map<string, ChromeDeviceInfo>();
  for (const entry of entries.filter(isChromeDeviceFile)) {
    try {
      const parsed = asRecord(JSON.parse(await readGoogleZipEntryText(entry)));
      if (!parsed) throw new Error("Chrome device list is not a JSON object.");
      for (const [guid, info] of parseChromeDeviceInfo(parsed)) deviceInfo.set(guid, info);
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse Chrome device list";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse Chrome device list."}`);
    }
  }

  let typedUrlRows = 0;
  let sessionRows = 0;
  let sharedTabGroupRows = 0;
  let invalidUrlRows = 0;

  for (let index = 0; index < historyFiles.length; index += 1) {
    const entry = historyFiles[index];
    update(progress, {
      stage: "parsing",
      label: `Parsing Chrome history: ${entry.fileName}`,
      percent: formatPercent(index, historyFiles.length, 84, 5),
    });

    try {
      const text = await readGoogleZipEntryText(entry);
      const parsed = asRecord(JSON.parse(text));
      if (!parsed) {
        entry.status = "malformed";
        entry.reason = "Chrome history file is not a JSON object";
        warnings.push(`${entry.path}: Chrome history file is not a JSON object.`);
        continue;
      }

      const browserHistory = asArray(parsed["Browser History"]);
      typedUrlRows += asArray(parsed["Typed Url"]).length;
      sessionRows += asArray(parsed.Session).length;
      sharedTabGroupRows += asArray(parsed["Shared Tab Group"]).length;

      browserHistory.forEach((value, rowIndex) => {
        const record = asRecord(value);
        if (!record) return;
        const title = typeof record.title === "string" ? record.title : undefined;
        const url = typeof record.url === "string" ? record.url : undefined;
        const host = hostFromUrl(url);
        if (url && !host) invalidUrlRows += 1;
        const time = chromeUsecToIso(record.time_usec);
        const clientId = typeof record.client_id === "string" ? record.client_id : undefined;
        rows.push({
          id: stableId("chrome-history", entry.path, rowIndex, time, title, url),
          title,
          url,
          host,
          time,
          clientId,
          sourcePath: entry.path,
        });
      });
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse Chrome history";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse Chrome history."}`);
    }
  }

  if (!rows.length && !warnings.length) return undefined;

  update(progress, { stage: "analyzing", label: "Aggregating Chrome history", percent: 89 });
  const dates: Date[] = [];
  const hosts = new Map<string, number>();
  const clients = new Map<string, { visits: number; first: number; last: number; hosts: Map<string, number> }>();
  const byWeek = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byYear = new Map<string, number>();
  const byHour = new Map<string, number>();
  const byWeekday = new Map<string, number>();
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const row of rows) {
    if (row.host) increment(hosts, row.host);
    const ms = row.time ? Date.parse(row.time) : Number.NaN;
    if (row.clientId) {
      let client = clients.get(row.clientId);
      if (!client) {
        client = { visits: 0, first: Number.POSITIVE_INFINITY, last: 0, hosts: new Map() };
        clients.set(row.clientId, client);
      }
      client.visits += 1;
      if (row.host) increment(client.hosts, row.host);
      if (!Number.isNaN(ms)) {
        if (ms < client.first) client.first = ms;
        if (ms > client.last) client.last = ms;
      }
    }
    if (Number.isNaN(ms)) continue;
    const date = new Date(ms);
    dates.push(date);
    increment(byWeek, weekKey(date));
    increment(byMonth, monthKey(date));
    increment(byYear, String(date.getUTCFullYear()));
    increment(byHour, `${String(date.getUTCHours()).padStart(2, "0")}:00`);
    increment(byWeekday, weekdayLabels[date.getUTCDay()]);
  }

  // Takeout only carries an opaque per-install ID, so devices are numbered by how much they were used.
  const rankedClients = [...clients.entries()].sort((a, b) => b[1].visits - a[1].visits || a[0].localeCompare(b[0]));
  const usedLabels = new Map<string, number>();
  let olderInstalls = 0;
  const labels = rankedClients.map(([id], index) => {
    const info = deviceInfo.get(id);
    const base = info ? info.name : deviceInfo.size ? `Older install ${++olderInstalls}` : `Device ${index + 1}`;
    const seen = (usedLabels.get(base) ?? 0) + 1;
    usedLabels.set(base, seen);
    return seen > 1 ? `${base} (${seen})` : base;
  });
  const deviceLabels = new Map(rankedClients.map(([id], index) => [id, labels[index]]));
  const signedInWithoutHistory = [...deviceInfo.entries()].filter(([id]) => !clients.has(id)).map(([, info]) => ({ label: info.name, platform: info.platform }));
  const devices: GoogleChromeDevice[] = rankedClients.slice(0, CHROME_DEVICE_LIMIT).map(([id, client], index) => ({
    label: labels[index],
    platform: deviceInfo.get(id)?.platform,
    chromeVersion: deviceInfo.get(id)?.chromeVersion,
    listed: deviceInfo.has(id),
    visits: client.visits,
    share: client.visits / rows.length,
    firstSeen: Number.isFinite(client.first) ? new Date(client.first).toISOString() : undefined,
    lastSeen: client.last > 0 ? new Date(client.last).toISOString() : undefined,
    topHosts: rankedFromCounts(client.hosts, 3),
  }));

  const sortedRows = [...rows].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  let minDate = Number.POSITIVE_INFINITY;
  let maxDate = 0;
  for (const date of dates) {
    const time = date.getTime();
    if (time < minDate) minDate = time;
    if (time > maxDate) maxDate = time;
  }
  const dateRange = dates.length
    ? {
        start: new Date(minDate).toISOString(),
        end: new Date(maxDate).toISOString(),
      }
    : undefined;

  return {
    total: rows.length,
    parsedFiles: historyFiles.filter((entry) => entry.status === "parsed").length,
    typedUrlRows,
    sessionRows,
    sharedTabGroupRows,
    invalidUrlRows,
    warnings,
    dateRange,
    uniqueHosts: hosts.size,
    uniqueClients: clients.size,
    topHosts: rankedFromCounts(hosts),
    devices,
    signedInWithoutHistory,
    historyByDay: dateCounts(dates, 120),
    daily: dateCounts(dates, Number.MAX_SAFE_INTEGER),
    historyByWeek: chronologicalRanked(byWeek, 104),
    historyByMonth: chronologicalRanked(byMonth, 72),
    historyByYear: chronologicalRanked(byYear, 20),
    historyByHour: Array.from({ length: 24 }, (_, hour) => {
      const label = `${String(hour).padStart(2, "0")}:00`;
      return { label, count: byHour.get(label) ?? 0 };
    }),
    historyByWeekday: weekdayLabels.map((label) => ({ label, count: byWeekday.get(label) ?? 0 })),
    busiestDay: busiestDay(dates),
    recentEntries: sortedRows.slice(0, CHROME_RECENT_LIMIT).map(({ clientId, ...row }) => ({ ...row, deviceLabel: clientId ? deviceLabels.get(clientId) : undefined })),
    recentEntryLimit: CHROME_RECENT_LIMIT,
    isEntryListCapped: rows.length > CHROME_RECENT_LIMIT,
  };
}

function unixSecondsToIso(value: unknown): string | undefined {
  const raw = asRecord(value)?.timestamp;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function photosMediaType(title: string | undefined, sidecarName: string): { mediaType: GooglePhotosEntry["mediaType"]; extension: string } {
  const name = (title || sidecarName.replace(/\.su[a-z-]*(\(\d+\))?\.json$/i, "").replace(/\.json$/i, "")).toLowerCase();
  const extension = /\.[a-z0-9]{2,5}$/.exec(name)?.[0] ?? "(none)";
  if (PHOTO_EXTS.has(extension)) return { mediaType: "photo", extension };
  if (VIDEO_EXTS.has(extension)) return { mediaType: "video", extension };
  return { mediaType: "other", extension };
}

const PHOTO_SOURCE_LABELS: Record<string, string> = {
  mobileUpload: "Mobile app upload",
  webUpload: "Web upload",
  fromPartnerSharing: "Partner sharing",
  fromSharedAlbum: "Shared album",
  composition: "Created by Google Photos",
  driveUpload: "Drive upload",
};

function photosAlbumFolder(entry: GoogleZipEntry): string | undefined {
  const parts = pathParts(entry);
  return parts[0] === "Google Photos" && parts.length > 2 ? parts[1] : undefined;
}

function photosLocation(record: Record<string, unknown>): { latitude: number; longitude: number } | undefined {
  for (const key of ["geoData", "geoDataExif"]) {
    const geo = asRecord(record[key]);
    if (typeof geo?.latitude === "number" && typeof geo.longitude === "number" && (geo.latitude !== 0 || geo.longitude !== 0)) {
      return { latitude: geo.latitude, longitude: geo.longitude };
    }
  }
  return undefined;
}

async function parseGooglePhotos(entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<GooglePhotosSummary | undefined> {
  const sidecars = entries.filter(isPhotosSidecarFile);
  if (!sidecars.length) return undefined;

  const rows: GooglePhotosEntry[] = [];
  const warnings: string[] = [];
  const extensions = new Map<string, number>();
  const folders = new Map<string, number>();
  let malformedFiles = 0;
  let withDescription = 0;
  let archived = 0;
  let trashed = 0;
  let totalViews = 0;

  const sidecarReader = createEntryReader(sidecars);
  for (let index = 0; index < sidecars.length; index += 1) {
    const entry = sidecars[index];
    if (index % 250 === 0) {
      update(progress, {
        stage: "parsing",
        label: `Parsing Google Photos metadata (${index.toLocaleString("en")} of ${sidecars.length.toLocaleString("en")})`,
        percent: formatPercent(index, sidecars.length, 89, 2),
      });
    }
    try {
      const record = asRecord(JSON.parse(await sidecarReader.read(entry)));
      if (!record) throw new Error("Sidecar is not a JSON object.");
      const title = typeof record.title === "string" && record.title ? record.title : undefined;
      const { mediaType, extension } = photosMediaType(title, entry.fileName);
      increment(extensions, extension);
      const origin = asRecord(record.googlePhotosOrigin);
      const originKey = origin ? Object.keys(origin)[0] : undefined;
      const mobile = asRecord(origin?.mobileUpload);
      const localFolder = asRecord(mobile?.deviceFolder)?.localFolderName;
      const location = photosLocation(record);
      const views = typeof record.imageViews === "string" ? Number(record.imageViews) || 0 : typeof record.imageViews === "number" ? record.imageViews : 0;
      const albumFolder = photosAlbumFolder(entry);
      if (albumFolder) increment(folders, albumFolder);
      if (typeof record.description === "string" && record.description.trim()) withDescription += 1;
      if (record.archived === true) archived += 1;
      if (record.trashed === true) trashed += 1;
      totalViews += views;
      const takenAt = unixSecondsToIso(record.photoTakenTime);
      rows.push({
        id: stableId("photos", entry.path, title, takenAt),
        title,
        mediaType,
        takenAt,
        uploadedAt: unixSecondsToIso(record.creationTime),
        source: originKey ? PHOTO_SOURCE_LABELS[originKey] ?? originKey : undefined,
        deviceType: typeof mobile?.deviceType === "string" ? mobile.deviceType : undefined,
        deviceFolder: typeof localFolder === "string" && localFolder ? localFolder : undefined,
        albumFolder,
        views,
        hasLocation: Boolean(location),
        latitude: location?.latitude,
        longitude: location?.longitude,
        favorited: record.favorited === true,
        url: typeof record.url === "string" ? record.url : undefined,
        sourcePath: entry.path,
      });
    } catch (error) {
      malformedFiles += 1;
      entry.status = "malformed";
      entry.reason = "Could not parse Photos sidecar";
      if (warnings.length < 5) warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse Photos sidecar."}`);
    }
  }

  let sharedAlbumComments = 0;
  for (const entry of entries.filter(isPhotosCommentsFile)) {
    try {
      sharedAlbumComments += asArray(asRecord(JSON.parse(await readGoogleZipEntryText(entry)))?.sharedAlbumComments).length;
    } catch {
      // Comments are optional; a bad file stays as an indexed coverage row.
    }
  }

  update(progress, { stage: "analyzing", label: "Aggregating Google Photos metadata", percent: 91 });
  const dates: Date[] = [];
  const byYear = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byWeekday = new Map<string, number>();
  const byHour = new Map<string, number>();
  const uploadsByYear = new Map<string, number>();
  const sources = new Map<string, number>();
  const deviceTypes = new Map<string, number>();
  const deviceFolders = new Map<string, number>();
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let photos = 0;
  let videos = 0;
  let otherMedia = 0;
  let withLocation = 0;
  let favorited = 0;

  for (const row of rows) {
    if (row.mediaType === "photo") photos += 1;
    else if (row.mediaType === "video") videos += 1;
    else otherMedia += 1;
    if (row.hasLocation) withLocation += 1;
    if (row.favorited) favorited += 1;
    if (row.source) increment(sources, row.source);
    if (row.deviceType) increment(deviceTypes, row.deviceType);
    if (row.deviceFolder) increment(deviceFolders, row.deviceFolder);
    if (row.uploadedAt) increment(uploadsByYear, row.uploadedAt.slice(0, 4));
    if (!row.takenAt) continue;
    const date = new Date(row.takenAt);
    dates.push(date);
    increment(byYear, String(date.getUTCFullYear()));
    increment(byMonth, monthKey(date));
    increment(byWeekday, weekdayLabels[date.getUTCDay()]);
    increment(byHour, `${String(date.getUTCHours()).padStart(2, "0")}:00`);
  }

  let minDate = Number.POSITIVE_INFINITY;
  let maxDate = 0;
  for (const date of dates) {
    const time = date.getTime();
    if (time < minDate) minDate = time;
    if (time > maxDate) maxDate = time;
  }

  const yearFolders = [...folders.keys()].filter((name) => PHOTOS_YEAR_FOLDER_RE.test(name));
  const albumFolders = new Map([...folders.entries()].filter(([name]) => !PHOTOS_YEAR_FOLDER_RE.test(name)));

  return {
    total: rows.length,
    photos,
    videos,
    otherMedia,
    parsedFiles: sidecars.length - malformedFiles,
    malformedFiles,
    warnings,
    dateRange: dates.length ? { start: new Date(minDate).toISOString(), end: new Date(maxDate).toISOString() } : undefined,
    withLocation,
    withDescription,
    favorited,
    archived,
    trashed,
    totalViews,
    albumCount: albumFolders.size,
    yearFolderCount: yearFolders.length,
    topAlbums: rankedFromCounts(albumFolders),
    byYear: chronologicalRanked(byYear, 30),
    byMonth: chronologicalRanked(byMonth, 120),
    byWeekday: weekdayLabels.map((label) => ({ label, count: byWeekday.get(label) ?? 0 })),
    byHour: Array.from({ length: 24 }, (_, hour) => {
      const label = `${String(hour).padStart(2, "0")}:00`;
      return { label, count: byHour.get(label) ?? 0 };
    }),
    uploadsByYear: chronologicalRanked(uploadsByYear, 30),
    sources: rankedFromCounts(sources),
    deviceTypes: rankedFromCounts(deviceTypes),
    deviceFolders: rankedFromCounts(deviceFolders),
    extensions: rankedFromCounts(extensions),
    daily: dateCounts(dates, Number.MAX_SAFE_INTEGER),
    busiestDay: busiestDay(dates),
    recentEntries: [...rows].sort((a, b) => (b.takenAt ?? "").localeCompare(a.takenAt ?? "")).slice(0, PHOTOS_RECENT_LIMIT),
    recentEntryLimit: PHOTOS_RECENT_LIMIT,
    isEntryListCapped: rows.length > PHOTOS_RECENT_LIMIT,
    sharedAlbumComments,
  };
}

const PLAY_FILES = new Set([
  "installs.json",
  "purchase history.json",
  "library.json",
  "order history.json",
  "subscriptions.json",
  "devices.json",
  "play points.json",
  "play settings.json",
  "promotion history.json",
]);

function isPlayStoreFile(entry: GoogleZipEntry): boolean {
  return entry.product === "Google Play Store" && PLAY_FILES.has(entry.fileName.toLowerCase());
}

function parsePlayPrice(value: unknown): { amount: number; currency?: string } {
  if (typeof value !== "string") return { amount: 0 };
  const match = /^\s*([^\d\s.,-]*)\s*(-?[\d.,]*\d)\s*([^\d\s.,-]*)\s*$/.exec(value);
  if (!match) return { amount: 0 };
  const number = match[2].includes(",") && !/,\d{3}(\D|$)/.test(match[2]) ? match[2].replace(",", ".") : match[2].replace(/,/g, "");
  const amount = Number.parseFloat(number);
  return { amount: Number.isFinite(amount) ? amount : 0, currency: match[1] || match[3] || undefined };
}

function playItem(record: Record<string, unknown> | undefined): { title: string; documentType?: string } {
  const doc = asRecord(record?.doc);
  return {
    title: typeof doc?.title === "string" && doc.title ? doc.title : "Untitled",
    documentType: typeof doc?.documentType === "string" ? doc.documentType : undefined,
  };
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function parsePlayStore(entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<GooglePlaySummary | undefined> {
  const files = entries.filter(isPlayStoreFile);
  if (!files.length) return undefined;
  update(progress, { stage: "parsing", label: "Parsing Google Play Store", percent: 91 });

  const warnings: string[] = [];
  const rowsByFile = new Map<string, unknown[]>();
  for (const entry of files) {
    try {
      const parsed = JSON.parse(await readGoogleZipEntryText(entry)) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array.");
      rowsByFile.set(entry.fileName.toLowerCase(), parsed);
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse Play Store file";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse Play Store file."}`);
    }
  }
  const rows = (name: string) => rowsByFile.get(name) ?? [];
  const times: number[] = [];
  const noteTime = (iso?: string) => {
    if (iso) times.push(new Date(iso).getTime());
  };

  const installs: GooglePlayInstall[] = [];
  for (const row of rows("installs.json")) {
    const install = asRecord(asRecord(row)?.install);
    if (!install) continue;
    const firstInstalledAt = isoOrUndefined(install.firstInstallationTime);
    const device = asRecord(install.deviceAttribute);
    noteTime(firstInstalledAt);
    installs.push({
      ...playItem(install),
      device: typeof device?.deviceDisplayName === "string" ? device.deviceDisplayName : undefined,
      firstInstalledAt,
      lastUpdatedAt: isoOrUndefined(install.lastUpdateTime),
    });
  }
  const installTitles = new Map<string, Set<string>>();
  const installsByYear = new Map<string, number>();
  const installsByDevice = new Map<string, number>();
  const installsByType = new Map<string, number>();
  for (const install of installs) {
    const devices = installTitles.get(install.title) ?? new Set<string>();
    devices.add(install.device ?? "unknown");
    installTitles.set(install.title, devices);
    if (install.firstInstalledAt) increment(installsByYear, install.firstInstalledAt.slice(0, 4));
    if (install.device) increment(installsByDevice, install.device);
    if (install.documentType) increment(installsByType, install.documentType);
  }
  const datedInstalls = installs.filter((install) => install.firstInstalledAt);
  const newestInstalls = [...datedInstalls].sort((a, b) => (b.firstInstalledAt ?? "").localeCompare(a.firstInstalledAt ?? ""));

  const purchases: GooglePlayPurchase[] = [];
  for (const row of rows("purchase history.json")) {
    const purchase = asRecord(asRecord(row)?.purchaseHistory);
    if (!purchase) continue;
    const time = isoOrUndefined(purchase.purchaseTime);
    const price = parsePlayPrice(purchase.invoicePrice);
    noteTime(time);
    purchases.push({
      ...playItem(purchase),
      price: typeof purchase.invoicePrice === "string" ? purchase.invoicePrice : undefined,
      amount: price.amount,
      currency: price.currency,
      paymentMethod: typeof purchase.paymentMethodTitle === "string" ? purchase.paymentMethodTitle : undefined,
      time,
    });
  }
  const spend = new Map<string, GooglePlaySpend>();
  const purchasesByYear = new Map<string, number>();
  const purchasesByType = new Map<string, number>();
  const paymentMethods = new Map<string, number>();
  for (const purchase of purchases) {
    if (purchase.amount > 0) {
      const currency = purchase.currency ?? "?";
      const entry = spend.get(currency) ?? { currency, total: 0, purchases: 0 };
      entry.total += purchase.amount;
      entry.purchases += 1;
      spend.set(currency, entry);
    }
    if (purchase.time) increment(purchasesByYear, purchase.time.slice(0, 4));
    if (purchase.documentType) increment(purchasesByType, purchase.documentType);
    if (purchase.paymentMethod) increment(paymentMethods, purchase.paymentMethod);
  }
  const paid = purchases.filter((purchase) => purchase.amount > 0);

  const libraryByType = new Map<string, number>();
  const libraryRows = rows("library.json");
  for (const row of libraryRows) {
    const doc = playItem(asRecord(asRecord(row)?.libraryDoc));
    if (doc.documentType) increment(libraryByType, doc.documentType);
    noteTime(isoOrUndefined(asRecord(asRecord(row)?.libraryDoc)?.acquisitionTime));
  }

  const ordersByYear = new Map<string, number>();
  const orderRows = rows("order history.json");
  for (const row of orderRows) {
    const created = isoOrUndefined(asRecord(asRecord(row)?.orderHistory)?.creationTime);
    noteTime(created);
    if (created) increment(ordersByYear, created.slice(0, 4));
  }

  const subscriptions: GooglePlaySubscription[] = [];
  for (const row of rows("subscriptions.json")) {
    const sub = asRecord(asRecord(row)?.subscription);
    if (!sub) continue;
    const pricing = asArray(sub.pricing).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
    const current = pricing.find((item) => item.repeatedPricing === true) ?? pricing[pricing.length - 1];
    const period = asRecord(current?.period);
    subscriptions.push({
      title: playItem(sub).title,
      state: typeof sub.state === "string" ? sub.state : undefined,
      price: typeof current?.price === "string" ? current.price : undefined,
      period: period && typeof period.unit === "string" ? `${period.count ?? 1} ${String(period.unit).toLowerCase()}` : undefined,
      renewalDate: isoOrUndefined(sub.renewalDate),
      expirationDate: isoOrUndefined(sub.expirationDate),
    });
  }

  const devices: GooglePlayDevice[] = [];
  for (const row of rows("devices.json")) {
    const device = asRecord(asRecord(row)?.device);
    if (!device) continue;
    const data = asRecord(device.mostRecentData);
    const manufacturer = typeof data?.manufacturer === "string" ? data.manufacturer : undefined;
    const model = typeof data?.modelName === "string" ? data.modelName : undefined;
    const memory = typeof data?.totalMemoryBytes === "string" ? Number(data.totalMemoryBytes) : NaN;
    const registeredAt = isoOrUndefined(device.deviceRegistrationTime);
    noteTime(registeredAt);
    devices.push({
      label: [manufacturer, model].filter(Boolean).join(" ") || "Unknown device",
      manufacturer,
      model,
      androidSdk: typeof data?.androidSdkVersion === "string" ? data.androidSdkVersion : undefined,
      memoryGb: Number.isFinite(memory) && memory > 0 ? Math.round((memory / 1024 ** 3) * 10) / 10 : undefined,
      country: typeof data?.deviceIpCountry === "string" ? data.deviceIpCountry : undefined,
      locale: typeof data?.userLocale === "string" ? data.userLocale : undefined,
      registeredAt,
      lastActiveAt: isoOrUndefined(device.lastTimeDeviceActive),
    });
  }
  devices.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));

  const pointsRows = rows("play points.json");
  let playPoints: GooglePlaySummary["playPoints"];
  if (pointsRows.length) {
    const membership = asRecord(asRecord(asRecord(pointsRows.find((row) => asRecord(asRecord(row)?.playPointsDetails)?.membership))?.playPointsDetails)?.membership);
    const balance = typeof membership?.pointsBalance === "string" ? Number(membership.pointsBalance) : NaN;
    playPoints = {
      level: typeof membership?.level === "string" ? membership.level : undefined,
      status: typeof membership?.status === "string" ? membership.status : undefined,
      balance: Number.isFinite(balance) ? balance : undefined,
      historyRows: pointsRows.filter((row) => asRecord(asRecord(row)?.playPointsDetails)?.pointsHistory).length,
    };
  }

  const validTimes = times.filter((time) => Number.isFinite(time));
  return {
    installs: {
      total: installs.length,
      uniqueApps: installTitles.size,
      multiDeviceApps: [...installTitles.values()].filter((set) => set.size > 1).length,
      byYear: chronologicalRanked(installsByYear, 20),
      byDevice: rankedFromCounts(installsByDevice),
      byType: rankedFromCounts(installsByType),
      recent: newestInstalls.slice(0, PLAY_LIST_LIMIT),
      oldest: [...newestInstalls].reverse().slice(0, 10),
      recentLimit: PLAY_LIST_LIMIT,
      isCapped: newestInstalls.length > PLAY_LIST_LIMIT,
    },
    purchases: {
      total: purchases.length,
      free: purchases.length - paid.length,
      paid: paid.length,
      spend: [...spend.values()].sort((a, b) => b.total - a.total),
      byYear: chronologicalRanked(purchasesByYear, 20),
      byType: rankedFromCounts(purchasesByType),
      paymentMethods: rankedFromCounts(paymentMethods),
      topPaid: [...paid].sort((a, b) => b.amount - a.amount).slice(0, 10),
      recent: [...purchases].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).slice(0, PLAY_LIST_LIMIT),
      recentLimit: PLAY_LIST_LIMIT,
      isCapped: purchases.length > PLAY_LIST_LIMIT,
    },
    library: { total: libraryRows.length, byType: rankedFromCounts(libraryByType) },
    orders: { total: orderRows.length, byYear: chronologicalRanked(ordersByYear, 20) },
    subscriptions,
    devices,
    playPoints,
    interestSettings: rows("play settings.json").length,
    promotionRows: rows("promotion history.json").length,
    dateRange: validTimes.length ? { start: new Date(Math.min(...validTimes)).toISOString(), end: new Date(Math.max(...validTimes)).toISOString() } : undefined,
    parsedFiles: files.filter((entry) => entry.status === "parsed").length,
    warnings,
  };
}

async function parseYouTubeHistory(entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<YouTubeUnpackedData | undefined> {
  const historyFiles = entries.filter(isYouTubeHistoryFile);
  if (!historyFiles.length) return undefined;

  const jsonFiles = new Map<string, string>();
  const htmlFiles = new Map<string, string>();
  const warnings: string[] = [];

  for (let index = 0; index < historyFiles.length; index += 1) {
    const entry = historyFiles[index];
    update(progress, {
      stage: "parsing",
      label: `Parsing YouTube history: ${entry.fileName}`,
      percent: formatPercent(index, historyFiles.length, 89, 4),
    });

    try {
      const text = await readGoogleZipEntryText(entry);
      const fileName = entry.fileName.toLowerCase();
      if (fileName.endsWith(".json")) jsonFiles.set(fileName, text);
      else htmlFiles.set(fileName, text);
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not read YouTube history";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not read YouTube history."}`);
    }
  }

  if (!jsonFiles.size && !htmlFiles.size && warnings.length) {
    return {
      fileName: "Google Takeout YouTube history",
      generatedAt: new Date().toISOString(),
      sourceFiles: [],
      coverage: [
        { key: "watch", label: "Watch history" },
        { key: "search", label: "Search history" },
      ],
      watch: { total: 0, adViews: 0, removedOrUnavailable: 0, distinctChannels: 0, recent: [] },
      search: { total: 0, distinctQueries: 0, recent: [] },
      topChannels: [],
      topSearchQueries: [],
      activityByDay: [],
      activityByWeek: [],
      activityByMonth: [],
      activityByYear: [],
      activityByHour: [],
      activityByWeekday: [],
      topRewatchedVideos: [],
      musicWatchShare: 0,
      exportSections: [
        { key: "watch", label: "Watch history", description: "Videos and ads YouTube recorded you watching, with channel and timestamp.", files: ["watch-history.json", "watch-history.html"], rows: 0, status: "missing" },
        { key: "search", label: "Search history", description: "Search queries run on YouTube, with timestamp and result link.", files: ["search-history.json", "search-history.html"], rows: 0, status: "missing" },
      ],
      warnings,
    };
  }

  try {
    const youtube = parseYouTubeHistoryTexts({
      fileName: "Google Takeout YouTube history",
      jsonFiles,
      htmlFiles,
    });
    youtube.warnings = [...warnings, ...youtube.warnings];
    return youtube;
  } catch (error) {
    for (const entry of historyFiles) {
      entry.status = "malformed";
      entry.reason = "Could not parse YouTube history";
    }
    warnings.push(`YouTube and YouTube Music/history: ${error instanceof Error ? error.message : "Could not parse YouTube history."}`);
    return {
      fileName: "Google Takeout YouTube history",
      generatedAt: new Date().toISOString(),
      sourceFiles: [...jsonFiles.keys(), ...htmlFiles.keys()].sort(),
      coverage: [
        { key: "watch", label: "Watch history" },
        { key: "search", label: "Search history" },
      ],
      watch: { total: 0, adViews: 0, removedOrUnavailable: 0, distinctChannels: 0, recent: [] },
      search: { total: 0, distinctQueries: 0, recent: [] },
      topChannels: [],
      topSearchQueries: [],
      activityByDay: [],
      activityByWeek: [],
      activityByMonth: [],
      activityByYear: [],
      activityByHour: [],
      activityByWeekday: [],
      topRewatchedVideos: [],
      musicWatchShare: 0,
      exportSections: [
        { key: "watch", label: "Watch history", description: "Videos and ads YouTube recorded you watching, with channel and timestamp.", files: ["watch-history.json", "watch-history.html"], rows: 0, status: "missing" },
        { key: "search", label: "Search history", description: "Search queries run on YouTube, with timestamp and result link.", files: ["search-history.json", "search-history.html"], rows: 0, status: "missing" },
      ],
      warnings,
    };
  }
}

function buildProducts(entries: GoogleZipEntry[]): GoogleProductSummary[] {
  const products = new Map<string, GoogleProductSummary & { extensionCounts: Map<string, number> }>();
  for (const entry of entries) {
    const existing =
      products.get(entry.product) ??
      ({
        product: entry.product,
        files: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        parsed: 0,
        deferred: 0,
        skipped: 0,
        malformed: 0,
        unsupported: 0,
        extensions: [],
        serviceStatus: "indexed",
        extensionCounts: new Map<string, number>(),
      } satisfies GoogleProductSummary & { extensionCounts: Map<string, number> });
    existing.files += 1;
    existing.compressedSize += entry.compressedSize;
    existing.uncompressedSize += entry.uncompressedSize;
    if (entry.status === "parsed") existing.parsed += 1;
    else if (entry.status === "deferred") existing.deferred += 1;
    else if (entry.status === "skipped") existing.skipped += 1;
    else if (entry.status === "malformed") existing.malformed += 1;
    else if (entry.status === "unsupported") existing.unsupported += 1;
    increment(existing.extensionCounts, entry.extension || "(none)");
    if (existing.parsed > 0) existing.serviceStatus = "parsed";
    else if (existing.unsupported > 0) existing.serviceStatus = "unsupported";
    else if (existing.malformed > 0) existing.serviceStatus = "malformed";
    else if (existing.deferred > 0) existing.serviceStatus = "deferred";
    products.set(entry.product, existing);
  }
  return [...products.values()]
    .map(({ extensionCounts, ...product }) => ({ ...product, extensions: rankedFromCounts(extensionCounts, 6) }))
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize || a.product.localeCompare(b.product));
}

function productFiles(entries: GoogleZipEntry[], products: string[]): GoogleZipEntry[] {
  const wanted = new Set(products);
  return entries.filter((entry) => wanted.has(entry.product));
}

function buildServices(entries: GoogleZipEntry[], activity?: GoogleActivitySummary, chromeHistory?: GoogleChromeHistorySummary, photos?: GooglePhotosSummary, playStore?: GooglePlaySummary, more?: GoogleMoreServices, fit?: GoogleFitSummary, mail?: GoogleMailSummary, gemini?: GoogleGeminiSummary, playGames?: GooglePlayGamesSummary, drive?: GoogleDriveSummary, pending: GoogleSectionKey[] = []): GoogleServiceAvailability[] {
  const activityFiles = entries.filter((entry) => entry.product === "My Activity");
  const chromeFiles = productFiles(entries, ["Chrome"]);
  const youtubeFiles = productFiles(entries, ["YouTube and YouTube Music"]);
  const youtubeParsed = youtubeFiles.some((entry) => entry.status === "parsed");
  const services: GoogleServiceAvailability[] = [
    {
      key: "activity",
      label: SERVICE_LABELS.activity,
      status: activity ? "parsed" : activityFiles.length ? "available" : "missing",
      files: activityFiles.length,
      note: activity ? "Activity trends parsed for the initial service set." : "Search, Chrome, Maps, YouTube, and other activity files.",
    },
    {
      key: "chrome",
      label: SERVICE_LABELS.chrome,
      status: chromeHistory?.parsedFiles ? "parsed" : chromeFiles.length ? "available" : "missing",
      files: chromeFiles.length,
      note: chromeHistory?.parsedFiles ? "Browser history, domains, clients, and visit patterns parsed." : "Structured Chrome history can become a tab when History.json is present.",
    },
    {
      key: "youtube",
      label: SERVICE_LABELS.youtube,
      status: youtubeParsed ? "parsed" : youtubeFiles.length ? "available" : "missing",
      files: youtubeFiles.length,
      note: youtubeParsed ? "Watch and search history parsed through the shared YouTube parser." : "Watch/search history can be parsed when present.",
    },
    photosServiceCard(productFiles(entries, ["Google Photos"]).length, photos, pending.includes("photos")),
    fitServiceCard(productFiles(entries, ["Fit"]).length, fit, pending.includes("fit")),
    { key: "maps", label: SERVICE_LABELS.maps, status: productFiles(entries, ["Maps", "Timeline", "Maps (your places)"]).length ? "available" : "missing", files: productFiles(entries, ["Maps", "Timeline", "Maps (your places)"]).length, note: "Location-heavy data gets a later privacy-first pass." },
    {
      key: "play",
      label: SERVICE_LABELS.play,
      status: playStore?.parsedFiles ? "parsed" : productFiles(entries, ["Google Play Store"]).length ? "available" : "missing",
      files: productFiles(entries, ["Google Play Store"]).length,
      note: playStore?.parsedFiles ? "Installs, purchases, library, subscriptions, and devices parsed." : "Purchases, installs, subscriptions, and devices.",
    },
    mailServiceCard(productFiles(entries, ["Mail"]).length, mail, pending.includes("mail")),
    {
      key: "gemini",
      label: SERVICE_LABELS.gemini,
      status: gemini?.parsedFiles ? "parsed" : "missing",
      files: entries.filter((entry) => relativeTakeoutPath(entry.path).startsWith("My Activity/Gemini Apps/")).length,
      note: gemini?.parsedFiles ? "Prompts, replies, and conversations parsed; attached and generated files are counted, not opened." : "Gemini Apps activity can become a tab when present.",
    },
    {
      key: "games",
      label: SERVICE_LABELS.games,
      status: playGames?.parsedFiles ? "parsed" : productFiles(entries, ["Google Play Games Services"]).length ? "available" : "missing",
      files: productFiles(entries, ["Google Play Games Services"]).length,
      note: playGames?.parsedFiles ? "Playtime, streaks, achievements, scores, and XP parsed; account-linking tokens and cloud-save files are not read." : "Playtime, streaks, achievements, and scores can become a tab when present.",
    },
    {
      key: "drive",
      label: SERVICE_LABELS.drive,
      status: drive ? "parsed" : "missing",
      files: productFiles(entries, ["Drive"]).length,
      note: drive ? "File names, sizes, and dates read from the ZIP index; no Drive file is opened, and nested archives stay closed." : "Storage breakdown can become a tab when Drive files are present.",
    },
    {
      key: "contacts",
      label: SERVICE_LABELS.contacts,
      status: more?.contacts ? "parsed" : productFiles(entries, ["Contacts"]).length ? "available" : "missing",
      files: productFiles(entries, ["Contacts"]).length,
      note: more?.contacts ? "Contacts parsed from the VCF file." : "VCF/contact metadata can become a small tab.",
    },
    {
      key: "calendar",
      label: SERVICE_LABELS.calendar,
      status: more?.calendar ? "parsed" : productFiles(entries, ["Calendar"]).length ? "available" : "missing",
      files: productFiles(entries, ["Calendar"]).length,
      note: more?.calendar ? "Calendar events parsed from ICS files." : "Calendar events are structured but privacy-sensitive.",
    },
    {
      key: "tasks",
      label: SERVICE_LABELS.tasks,
      status: more?.tasks ? "parsed" : productFiles(entries, ["Tasks"]).length ? "available" : "missing",
      files: productFiles(entries, ["Tasks"]).length,
      note: more?.tasks ? "Task lists parsed." : "Small structured service candidate.",
    },
    {
      key: "chat",
      label: SERVICE_LABELS.chat,
      status: more?.chat ? "parsed" : productFiles(entries, ["Google Chat"]).length ? "available" : "missing",
      files: productFiles(entries, ["Google Chat"]).length,
      note: more?.chat ? "Conversations and messages parsed." : "Message text and names need privacy mode.",
    },
  ];
  return services;
}

export type GoogleParseOptions = {
  /** Skip Photos, Gmail, and Fit (the slow sections) so the dashboard can show first; read them later with parseGoogleSection. */
  deferSections?: boolean;
};

export type GoogleSectionEntries = Partial<Record<GoogleSectionKey, GoogleZipEntry[]>>;

function sectionHasFiles(key: GoogleSectionKey, entries: GoogleZipEntry[]): boolean {
  if (key === "photos") return entries.some(isPhotosSidecarFile);
  if (key === "mail") return entries.some(isMailFile);
  return entries.some(isFitFile);
}

export async function parseGoogleTakeout(files: File[], progress?: ProgressCallback): Promise<GoogleUnpackedData> {
  return (await parseGoogleTakeoutCore(files, progress)).data;
}

export async function parseGoogleTakeoutCore(files: File[], progress?: ProgressCallback, options: GoogleParseOptions = {}): Promise<{ data: GoogleUnpackedData; sectionEntries: GoogleSectionEntries }> {
  if (!files.length) fail("Choose one or more Google Takeout ZIP files.");
  const zipFiles = files.filter((file) => file.name.toLowerCase().endsWith(".zip"));
  const notZip = files.filter((file) => !file.name.toLowerCase().endsWith(".zip"));
  if (notZip.length) {
    const tarball = notZip.find((file) => /\.(tgz|tar|gz|tar\.gz)$/i.test(file.name));
    if (tarball) {
      fail("This is a .tgz archive, and this viewer reads .zip only. Request your Takeout again at takeout.google.com and choose .zip as the file type.", tarball.name);
    }
    fail(
      zipFiles.length
        ? `${notZip.length === 1 ? "One selected file is" : `${notZip.length} selected files are`} not a .zip, so nothing was read. Select only the .zip parts Google gave you.`
        : "These are not Takeout .zip files. They look like files from inside an export, or from an extracted folder. Select the original .zip parts Google gave you instead.",
      notZip[0].name,
    );
  }

  update(progress, { stage: "reading", label: "Reading Google Takeout ZIPs", percent: 1 });
  const archives: GoogleIndexedArchive[] = [];
  const archiveWarnings: string[] = [];
  for (let index = 0; index < zipFiles.length; index += 1) {
    const file = zipFiles[index];
    update(progress, { stage: "indexing", label: `Indexing ${file.name}`, percent: formatPercent(index, zipFiles.length, 4, 34) });
    try {
      archives.push(await indexGoogleZip(file));
    } catch (error) {
      fail(error instanceof Error ? error.message : "This ZIP file could not be indexed.", file.name);
    }
  }

  const entries = archives.flatMap((archive) => archive.entries);
  if (!entries.length) fail("No files were found inside the selected Google Takeout ZIPs.");
  for (const entry of entries) {
    const classification = classifyEntry(entry);
    entry.status = classification.status;
    entry.reason = classification.reason;
  }
  for (const archive of archives) archiveWarnings.push(...archive.warnings);

  update(progress, { stage: "extracting", label: "Inflating selected My Activity files", percent: 44 });
  const activity = await parseMyActivity(entries, progress);
  const chromeHistory = await parseChromeHistory(entries, progress);
  const deferred = options.deferSections ? DEFERRABLE_SECTIONS.filter((section) => sectionHasFiles(section.key, entries)) : [];
  const isDeferred = (key: GoogleSectionKey) => deferred.some((section) => section.key === key);
  const photos = isDeferred("photos") ? undefined : await parseGooglePhotos(entries, progress);
  const playStore = await parsePlayStore(entries, progress);
  const mail = isDeferred("mail") ? undefined : await parseMail(entries, progress);
  const moreServices = await parseSmallServices(entries, progress);
  const fit = isDeferred("fit") ? undefined : await parseFit(entries, progress);
  const gemini = await parseGemini(entries, progress);
  const playGames = await parsePlayGames(entries, progress);
  const drive = await parseDrive(entries, progress);
  const youtube = await parseYouTubeHistory(entries, progress);

  update(progress, { stage: "analyzing", label: "Building Google Takeout coverage", percent: 90 });
  const products = buildProducts(entries);
  const selectedSize = zipFiles.reduce((sum, file) => sum + file.size, 0);
  const compressedSize = entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const uncompressedSize = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const countStatus = (status: GoogleCoverageStatus) => entries.filter((entry) => entry.status === status).length;
  const largestFiles = [...entries]
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize || a.path.localeCompare(b.path))
    .slice(0, LARGEST_FILE_LIMIT)
    .map((entry) => ({
      path: entry.path,
      product: entry.product,
      fileName: entry.fileName,
      sourceArchive: entry.sourceArchive,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      status: entry.status,
      reason: entry.reason,
    }));

  update(progress, { stage: "complete", label: "Google Takeout ready", percent: 100 });
  const data: GoogleUnpackedData = {
    generatedAt: new Date().toISOString(),
    summary: {
      archiveCount: zipFiles.length,
      entryCount: entries.length,
      productCount: products.length,
      selectedSize,
      compressedSize,
      uncompressedSize,
      parsed: countStatus("parsed"),
      deferred: countStatus("deferred"),
      skipped: countStatus("skipped"),
      malformed: countStatus("malformed"),
      unsupported: countStatus("unsupported"),
    },
    archives: archives.map((archive) => ({
      fileName: archive.fileName,
      size: archive.size,
      entries: archive.entries.length,
      warnings: archive.warnings.length,
      status: "indexed",
    })),
    products,
    largestFiles,
    services: buildServices(entries, activity, chromeHistory, photos, playStore, moreServices, fit, mail, gemini, playGames, drive, deferred.map((section) => section.key)),
    warnings: [...archiveWarnings, ...(activity?.warnings ?? []), ...(chromeHistory?.warnings ?? []), ...(photos?.warnings ?? []), ...(playStore?.warnings ?? []), ...(moreServices?.warnings ?? []), ...(fit?.warnings ?? []), ...(mail?.warnings ?? []), ...(gemini?.warnings ?? []), ...(playGames?.warnings ?? []), ...(youtube?.warnings ?? [])],
    activity,
    chromeHistory,
    photos,
    playStore,
    moreServices,
    fit,
    mail,
    gemini,
    playGames,
    drive,
    youtube,
    ...(deferred.length ? { pending: deferred.map((section) => section.key) } : {}),
  };
  const sectionEntries: GoogleSectionEntries = {};
  for (const section of deferred) sectionEntries[section.key] = entries.filter((entry) => entry.product === section.product);
  return { data, sectionEntries };
}

// Where each deferred parser reports its progress inside the full pipeline, so a section can show 0 to 100 on its own.
const SECTION_PROGRESS: Record<GoogleSectionKey, [number, number]> = { photos: [89, 91], mail: [89, 91], fit: [93, 94] };

/** Reads one deferred section from the entries the core parse set aside for it. */
export async function parseGoogleSection(key: GoogleSectionKey, entries: GoogleZipEntry[], progress?: ProgressCallback): Promise<GoogleSectionResult> {
  const [low, high] = SECTION_PROGRESS[key];
  const scaled: ProgressCallback = (value) => progress?.({ ...value, percent: Math.min(99, Math.max(0, Math.round(((value.percent - low) / (high - low)) * 1000) / 10)) });
  const result: GoogleSectionResult = { key, malformed: [] };
  if (key === "photos") result.photos = await parseGooglePhotos(entries, scaled);
  else if (key === "mail") result.mail = await parseMail(entries, scaled);
  else result.fit = await parseFit(entries, scaled);
  result.malformed = entries.filter((entry) => entry.status === "malformed").map((entry) => ({ path: entry.path, reason: entry.reason ?? "Could not be read" }));
  return result;
}
