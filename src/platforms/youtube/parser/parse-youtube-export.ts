import { strFromU8, unzipSync } from "fflate";
import type {
  YouTubeCoverageWindow,
  YouTubeDayCount,
  YouTubeExportSection,
  YouTubeParserError,
  YouTubeParserProgress,
  YouTubeRankedItem,
  YouTubeSearchEntry,
  YouTubeUnpackedData,
  YouTubeWatchEntry,
} from "@/platforms/youtube/types";

type ProgressCallback = (progress: YouTubeParserProgress) => void;

export type YouTubeHistoryTextBundle = {
  fileName: string;
  jsonFiles: Map<string, string>;
  htmlFiles: Map<string, string>;
  generatedAt?: string;
};

type RawTakeoutEntry = {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: { name?: string; url?: string }[];
  time?: string;
  details?: { name?: string }[];
};

const MAX_SECTION_RECENT_ROWS = 80;
const TOP_CHANNEL_LIMIT = 15;
const TOP_QUERY_LIMIT = 15;
const HOUR_LABELS = [
  "12 AM", "1 AM", "2 AM", "3 AM", "4 AM", "5 AM", "6 AM", "7 AM", "8 AM", "9 AM", "10 AM", "11 AM",
  "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM", "9 PM", "10 PM", "11 PM",
];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TOP_VIDEO_LIMIT = 10;
const MIN_REWATCH_COUNT = 2;

const EXPECTED_SECTIONS: Omit<YouTubeExportSection, "rows" | "status">[] = [
  {
    key: "watch",
    label: "Watch history",
    description: "Videos and ads YouTube recorded you watching, with channel and timestamp.",
    files: ["watch-history.json", "watch-history.html"],
  },
  {
    key: "search",
    label: "Search history",
    description: "Search queries run on YouTube, with timestamp and result link.",
    files: ["search-history.json", "search-history.html"],
  },
];

function fail(message: string, fileName?: string): never {
  throw { fileName, message } satisfies YouTubeParserError;
}

function update(progress: ProgressCallback | undefined, progressValue: YouTubeParserProgress) {
  progress?.(progressValue);
}

function normalizeFileName(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? name.toLowerCase();
}

function parseYouTubeDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const HTML_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const HTML_OUTER_CELL_MARKER = 'class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"';
const HTML_TITLE_BLOCK_RE = /<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">([\s\S]*?)<\/div>/;
const HTML_ANCHOR_RE = /<a href="([^"]*)">([\s\S]*?)<\/a>/g;
const HTML_DATE_RE = /(\d{1,2})\s+(\w+)\s+(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})/;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/ /g, " ")
    .trim();
}

type HtmlActivityBlock = {
  verbText: string;
  anchors: { url: string; text: string }[];
  time?: string;
  isAd: boolean;
};

function htmlDateToIso(match: RegExpExecArray): string | undefined {
  const [, dayStr, monthStr, yearStr, hourStr, minStr, secStr] = match;
  const monthKeyRaw = monthStr.toLowerCase().startsWith("sep") ? "sep" : monthStr.toLowerCase().slice(0, 3);
  const month = HTML_MONTHS[monthKeyRaw];
  if (month === undefined) return undefined;
  const date = new Date(
    Date.UTC(Number(yearStr), month, Number(dayStr), Number(hourStr), Number(minStr), Number(secStr))
  );
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseHtmlActivityBlock(entryChunk: string): HtmlActivityBlock | undefined {
  const titleMatch = HTML_TITLE_BLOCK_RE.exec(entryChunk);
  if (!titleMatch) return undefined;
  const inner = titleMatch[1];

  const anchors: { url: string; text: string }[] = [];
  const anchorRe = new RegExp(HTML_ANCHOR_RE);
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(inner))) {
    anchors.push({ url: anchorMatch[1], text: decodeHtmlEntities(anchorMatch[2]) });
  }

  const verbText = decodeHtmlEntities(inner.split("<a ")[0] ?? "");
  const dateMatch = HTML_DATE_RE.exec(inner);
  const time = dateMatch ? htmlDateToIso(dateMatch) : undefined;
  const isAd = /From Google Ads/i.test(entryChunk);

  return { verbText, anchors, time, isAd };
}

function splitHtmlEntries(html: string): string[] {
  return html.split(HTML_OUTER_CELL_MARKER).slice(1);
}

function htmlEntriesToWatch(html: string): YouTubeWatchEntry[] {
  const entries: YouTubeWatchEntry[] = [];
  for (const chunk of splitHtmlEntries(html)) {
    const block = parseHtmlActivityBlock(chunk);
    if (!block || !block.verbText.startsWith("Watched")) continue;
    const [videoAnchor, channelAnchor] = block.anchors;
    const isRemoved = !videoAnchor;
    entries.push({
      title: isRemoved ? undefined : videoAnchor?.text,
      videoUrl: videoAnchor?.url,
      channelName: channelAnchor?.text,
      channelUrl: channelAnchor?.url,
      time: block.time,
      isAd: block.isAd,
      isRemoved,
    });
  }
  return entries;
}

function htmlEntriesToSearch(html: string): YouTubeSearchEntry[] {
  const entries: YouTubeSearchEntry[] = [];
  for (const chunk of splitHtmlEntries(html)) {
    const block = parseHtmlActivityBlock(chunk);
    if (!block || !block.verbText.startsWith("Searched for")) continue;
    const [queryAnchor] = block.anchors;
    entries.push({
      query: queryAnchor?.text,
      resultUrl: queryAnchor?.url,
      time: block.time,
    });
  }
  return entries;
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

function yearKey(date: Date): string {
  return String(date.getUTCFullYear());
}

function chronologicalDayCounts(dates: Date[], limit: number): YouTubeDayCount[] {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(dayKey(date), (counts.get(dayKey(date)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);
}

function chronologicalRanked(counts: Map<string, { count: number }>, limit: number): YouTubeRankedItem[] {
  return [...counts.entries()]
    .map(([label, value]) => ({ label, count: value.count }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-limit);
}

function rankedFromCounts(counts: Map<string, { count: number; url?: string }>, limit: number): YouTubeRankedItem[] {
  return [...counts.entries()]
    .filter(([label]) => label.length > 0)
    .map(([label, value]) => ({ label, count: value.count, channelUrl: value.url }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function countByDay(dates: Date[]): YouTubeDayCount[] {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(dayKey(date), (counts.get(dayKey(date)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date));
}

function busiestDay(dates: Date[]): YouTubeDayCount | undefined {
  return countByDay(dates)[0];
}

function longestStreak(dates: Date[]): { days: number; startDate: string; endDate: string } | undefined {
  const uniqueDays = [...new Set(dates.map(dayKey))].sort();
  if (!uniqueDays.length) return undefined;

  let bestStart = uniqueDays[0];
  let bestEnd = uniqueDays[0];
  let bestLength = 1;
  let runStart = uniqueDays[0];
  let runLength = 1;

  for (let i = 1; i < uniqueDays.length; i++) {
    const previous = new Date(`${uniqueDays[i - 1]}T00:00:00.000Z`);
    const current = new Date(`${uniqueDays[i]}T00:00:00.000Z`);
    const dayGap = Math.round((current.getTime() - previous.getTime()) / 86_400_000);
    if (dayGap === 1) {
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

function coverageWindow(key: string, label: string, dates: Date[]): YouTubeCoverageWindow {
  if (!dates.length) return { key, label };
  let first = dates[0];
  let last = dates[0];
  for (const date of dates) {
    if (date < first) first = date;
    if (date > last) last = date;
  }
  return { key, label, firstDate: first.toISOString(), lastDate: last.toISOString() };
}

function increment(map: Map<string, { count: number; url?: string }>, label: string | undefined, url?: string) {
  const trimmed = label?.trim();
  if (!trimmed) return;
  const existing = map.get(trimmed);
  map.set(trimmed, { count: (existing?.count ?? 0) + 1, url: existing?.url ?? url });
}

function stripPrefix(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function isAdEntry(entry: RawTakeoutEntry): boolean {
  return Boolean(entry.details?.some((detail) => /ad/i.test(detail.name ?? "")));
}

function isRemovedEntry(entry: RawTakeoutEntry): boolean {
  return !entry.titleUrl && /removed|unavailable/i.test(entry.title ?? "");
}

function toWatchEntry(entry: RawTakeoutEntry): YouTubeWatchEntry {
  const isAd = isAdEntry(entry);
  const isRemoved = isRemovedEntry(entry);
  const channel = entry.subtitles?.[0];
  return {
    title: isRemoved ? undefined : stripPrefix(entry.title, "Watched "),
    videoUrl: entry.titleUrl,
    channelName: channel?.name,
    channelUrl: channel?.url,
    time: parseYouTubeDate(entry.time)?.toISOString(),
    isAd,
    isRemoved,
  };
}

function toSearchEntry(entry: RawTakeoutEntry): YouTubeSearchEntry {
  return {
    query: stripPrefix(entry.title, "Searched for "),
    resultUrl: entry.titleUrl,
    time: parseYouTubeDate(entry.time)?.toISOString(),
  };
}

function sortedRecent<T extends { time?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
}

function cappedRecent<T extends { time?: string }>(rows: T[]): T[] {
  return sortedRecent(rows).slice(0, MAX_SECTION_RECENT_ROWS);
}

function parseEntries(text: string): RawTakeoutEntry[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is RawTakeoutEntry => Boolean(entry) && typeof entry === "object");
}

function buildExportSections(sourceFiles: Set<string>, watchCount: number, searchCount: number): YouTubeExportSection[] {
  const rowsByKey: Record<string, number> = { watch: watchCount, search: searchCount };
  return EXPECTED_SECTIONS.map((section) => {
    const present = [`${section.key}-history.json`, `${section.key}-history.html`].some((file) => sourceFiles.has(file));
    const rows = rowsByKey[section.key] ?? 0;
    return {
      ...section,
      rows,
      status: !present ? "missing" : rows > 0 ? "found" : "empty",
    };
  });
}

async function collectHistoryFiles(
  files: File[],
  progress?: ProgressCallback
): Promise<{ fileName: string; jsonFiles: Map<string, string>; htmlFiles: Map<string, string> }> {
  const jsonFiles = new Map<string, string>();
  const htmlFiles = new Map<string, string>();
  const fileName = files.length === 1 ? files[0].name : `${files.length} selected files`;

  for (const file of files) {
    const normalizedName = normalizeFileName(file.name);
    if (normalizedName.endsWith(".zip")) {
      update(progress, { stage: "extracting", label: `Opening ${file.name}`, percent: 18 });
      const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
      for (const [entryName, bytes] of Object.entries(archive)) {
        const shortName = normalizeFileName(entryName);
        if (shortName === "watch-history.json" || shortName === "search-history.json") {
          jsonFiles.set(shortName, strFromU8(bytes));
        } else if (shortName === "watch-history.html" || shortName === "search-history.html") {
          htmlFiles.set(shortName, strFromU8(bytes));
        }
      }
      continue;
    }

    if (normalizedName === "watch-history.json" || normalizedName === "search-history.json") {
      jsonFiles.set(normalizedName, await file.text());
    } else if (normalizedName === "watch-history.html" || normalizedName === "search-history.html") {
      htmlFiles.set(normalizedName, await file.text());
    }
  }

  return { fileName, jsonFiles, htmlFiles };
}

export async function parseYouTubeExport(files: File[], progress?: ProgressCallback): Promise<YouTubeUnpackedData> {
  if (!files.length) fail("Choose a Google Takeout ZIP, or the watch-history / search-history files directly.");

  update(progress, { stage: "reading", label: "Reading YouTube export", percent: 5 });
  const { fileName, jsonFiles, htmlFiles } = await collectHistoryFiles(files, progress);

  if (!jsonFiles.size && !htmlFiles.size) {
    fail(
      "No watch-history or search-history files found. Request a Google Takeout export of \"YouTube and YouTube Music\" with history included.",
      fileName
    );
  }

  update(progress, { stage: "parsing", label: `Parsing ${jsonFiles.size + htmlFiles.size} history files`, percent: 45 });
  const result = parseYouTubeHistoryTexts({ fileName, jsonFiles, htmlFiles });

  update(progress, { stage: "complete", label: "YouTube recap ready", percent: 100 });
  return result;
}

export function parseYouTubeHistoryTexts({
  fileName,
  jsonFiles,
  htmlFiles,
  generatedAt = new Date().toISOString(),
}: YouTubeHistoryTextBundle): YouTubeUnpackedData {
  const sourceFiles = new Set<string>([...jsonFiles.keys(), ...htmlFiles.keys()]);
  const watchUsedHtml = !jsonFiles.has("watch-history.json") && htmlFiles.has("watch-history.html");
  const searchUsedHtml = !jsonFiles.has("search-history.json") && htmlFiles.has("search-history.html");
  const usedHtml = watchUsedHtml || searchUsedHtml;

  const watchEntries: YouTubeWatchEntry[] = jsonFiles.has("watch-history.json")
    ? parseEntries(jsonFiles.get("watch-history.json")!)
        .filter((entry) => !entry.header || entry.header === "YouTube")
        .map(toWatchEntry)
    : watchUsedHtml
      ? htmlEntriesToWatch(htmlFiles.get("watch-history.html")!)
      : [];
  const searchEntries: YouTubeSearchEntry[] = jsonFiles.has("search-history.json")
    ? parseEntries(jsonFiles.get("search-history.json")!)
        .filter((entry) => !entry.header || entry.header === "YouTube")
        .map(toSearchEntry)
    : searchUsedHtml
      ? htmlEntriesToSearch(htmlFiles.get("search-history.html")!)
      : [];

  const watchDates = watchEntries.map((entry) => (entry.time ? new Date(entry.time) : undefined)).filter((date): date is Date => Boolean(date));
  const searchDates = searchEntries.map((entry) => (entry.time ? new Date(entry.time) : undefined)).filter((date): date is Date => Boolean(date));
  const allDates = [...watchDates, ...searchDates];

  const channelCounts = new Map<string, { count: number; url?: string }>();
  for (const entry of watchEntries) {
    if (!entry.isAd && !entry.isRemoved) increment(channelCounts, entry.channelName, entry.channelUrl);
  }

  const queryCounts = new Map<string, { count: number; url?: string }>();
  for (const entry of searchEntries) increment(queryCounts, entry.query?.toLowerCase());

  const weekCounts = new Map<string, { count: number }>();
  for (const date of allDates) increment(weekCounts, weekKey(date));

  const monthCounts = new Map<string, { count: number }>();
  for (const date of allDates) increment(monthCounts, monthKey(date));

  const yearCounts = new Map<string, { count: number }>();
  for (const date of allDates) increment(yearCounts, yearKey(date));

  const hourCounts = new Map<string, { count: number }>();
  for (const date of allDates) increment(hourCounts, HOUR_LABELS[date.getUTCHours()]);

  const weekdayCounts = new Map<string, { count: number }>();
  for (const date of allDates) increment(weekdayCounts, WEEKDAY_LABELS[date.getUTCDay()]);

  const adViews = watchEntries.filter((entry) => entry.isAd).length;
  const removedOrUnavailable = watchEntries.filter((entry) => entry.isRemoved).length;

  const rewatchCounts = new Map<string, { count: number; title: string; videoUrl?: string; channelName?: string }>();
  for (const entry of watchEntries) {
    if (entry.isAd || entry.isRemoved || !entry.title) continue;
    const key = entry.videoUrl ?? entry.title;
    const existing = rewatchCounts.get(key);
    rewatchCounts.set(key, {
      count: (existing?.count ?? 0) + 1,
      title: entry.title,
      videoUrl: entry.videoUrl ?? existing?.videoUrl,
      channelName: entry.channelName ?? existing?.channelName,
    });
  }
  const topRewatchedVideos = [...rewatchCounts.values()]
    .filter((video) => video.count >= MIN_REWATCH_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_VIDEO_LIMIT);

  const eligibleWatchCount = watchEntries.filter((entry) => !entry.isAd && !entry.isRemoved).length;
  const musicWatchCount = watchEntries.filter(
    (entry) => !entry.isAd && !entry.isRemoved && entry.videoUrl?.includes("music.youtube.com")
  ).length;
  const musicWatchShare = eligibleWatchCount > 0 ? musicWatchCount / eligibleWatchCount : 0;

  const longestActiveStreak = longestStreak(allDates);

  const hasWatchSource = jsonFiles.has("watch-history.json") || htmlFiles.has("watch-history.html");
  const hasSearchSource = jsonFiles.has("search-history.json") || htmlFiles.has("search-history.html");

  const warnings: string[] = [];
  if (!hasWatchSource) warnings.push("Missing watch-history file; watch history sections will be empty.");
  if (!hasSearchSource) warnings.push("Missing search-history file; search history sections will be empty.");
  if (usedHtml) {
    warnings.push(
      "Parsed from the HTML export format. Timestamps use the time zone label Google Takeout printed (e.g. \"IST\") without adjusting for it, so the day/hour/weekday patterns below reflect your account's own local clock, not exact UTC. Re-export in JSON format (Takeout → Multiple formats → YouTube and YouTube Music → History → JSON) for exact timestamps."
    );
  }

  return {
    fileName,
    generatedAt,
    sourceFiles: [...sourceFiles].sort(),
    coverage: [
      coverageWindow("watch", "Watch history", watchDates),
      coverageWindow("search", "Search history", searchDates),
    ],
    watch: {
      total: watchEntries.length,
      adViews,
      removedOrUnavailable,
      distinctChannels: channelCounts.size,
      busiestDay: busiestDay(watchDates),
      recent: cappedRecent(watchEntries),
    },
    search: {
      total: searchEntries.length,
      distinctQueries: queryCounts.size,
      busiestDay: busiestDay(searchDates),
      recent: cappedRecent(searchEntries),
    },
    topChannels: rankedFromCounts(channelCounts, TOP_CHANNEL_LIMIT),
    topSearchQueries: rankedFromCounts(queryCounts, TOP_QUERY_LIMIT),
    activityByDay: chronologicalDayCounts(allDates, 120),
    activityByWeek: chronologicalRanked(weekCounts, 104),
    activityByMonth: chronologicalRanked(monthCounts, 36),
    activityByYear: chronologicalRanked(yearCounts, 20),
    activityByHour: HOUR_LABELS.map((label) => ({ label, count: hourCounts.get(label)?.count ?? 0 })),
    activityByWeekday: WEEKDAY_LABELS.map((label) => ({ label, count: weekdayCounts.get(label)?.count ?? 0 })),
    topRewatchedVideos: topRewatchedVideos.map((video) => ({
      title: video.title,
      count: video.count,
      videoUrl: video.videoUrl,
      channelName: video.channelName,
    })),
    longestActiveStreak,
    musicWatchShare,
    exportSections: buildExportSections(sourceFiles, watchEntries.length, searchEntries.length),
    warnings,
  };
}
