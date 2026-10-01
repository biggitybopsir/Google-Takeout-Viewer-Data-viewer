import type { GoogleDayCount, GoogleGeminiConversation, GoogleGeminiExchange, GoogleGeminiSummary, GoogleParserProgress, GoogleRankedItem } from "@/platforms/google/types";
import { readGoogleZipEntryText, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import { decodeHtmlEntities, HTML_DATE_RE, htmlDateToIso, stableId, stripTags } from "@/platforms/google/parser/html";

const CONVERSATION_LIMIT = 300;
const EXCHANGE_LIMIT = 3_000;
const TEXT_LIMIT = 20_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const OUTER_CELL = '<div class="outer-cell';
const BODY_CELL_RE = /<div class="content-cell[^"]*mdl-typography--body-1(?![^"]*text-right)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const CONVERSATION_RE = /gemini\.google\.com\/app\/([A-Za-z0-9_-]+)/;
const GENERATED_IMAGES_RE = /^(\d+) generated images?\.?$/i;
const ATTACHED_RE = /^Attached (\d+) files?\.?$/i;
const FILE_ITEM_RE = /^-\s+\S/;
const LENGTH_BUCKETS: { label: string; max: number }[] = [
  { label: "Under 100", max: 100 },
  { label: "100 to 499", max: 500 },
  { label: "500 to 1,999", max: 2_000 },
  { label: "2,000 or more", max: Number.POSITIVE_INFINITY },
];

function takeoutParts(entry: GoogleZipEntry): string[] {
  const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return index >= 0 ? parts.slice(index + 1) : parts;
}

// The Gemini conversation log is one My Activity.html; the files and images a user attached or generated sit loose beside it.
export function isGeminiActivityFile(entry: GoogleZipEntry): boolean {
  const parts = takeoutParts(entry);
  return parts[0] === "My Activity" && parts[1] === "Gemini Apps" && parts.length === 3 && entry.fileName.toLowerCase() === "my activity.html";
}

function isGeminiFolderFile(entry: GoogleZipEntry): boolean {
  const parts = takeoutParts(entry);
  return parts[0] === "My Activity" && parts[1] === "Gemini Apps" && !isGeminiActivityFile(entry);
}

// Gemini replies are Markdown rendered to HTML; keep the shape readable as plain text.
function replyToText(html: string): string {
  const text = decodeHtmlEntities(
    html
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|h[1-6]|ul|ol|pre|li|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(value: string): { text: string; clipped: boolean } {
  return value.length > TEXT_LIMIT ? { text: value.slice(0, TEXT_LIMIT), clipped: true } : { text: value, clipped: false };
}

type ParsedBlock = { kind: "prompt"; exchange: GoogleGeminiExchange; conversationId: string } | { kind: "other" } | { kind: "malformed" };

function parseBlock(chunk: string, sourcePath: string, index: number): ParsedBlock {
  const body = BODY_CELL_RE.exec(chunk)?.[1];
  if (!body) return { kind: "malformed" };
  const dateMatch = HTML_DATE_RE.exec(body);
  const head = dateMatch ? body.slice(0, dateMatch.index) : body;
  const tail = dateMatch ? body.slice(dateMatch.index + dateMatch[0].length) : "";
  const lines = stripTags(head).split("\n").map((line) => line.replace(/\s+$/, ""));
  const first = (lines[0] ?? "").trimStart();
  const verb = /^Prompted(?:\s+|$)/.exec(first);
  if (!verb) return { kind: "other" };
  lines[0] = first.slice(verb[0].length);

  // Trailing "N generated image." / "Attached N files." / "- name" lines describe attachments, not the prompt itself.
  let end = lines.length;
  let cursor = lines.length;
  let images = 0;
  let attachedCount = 0;
  let files: string[] = [];
  let pending: string[] = [];
  while (cursor > 0) {
    const line = lines[cursor - 1].trim();
    if (!line) {
      cursor -= 1;
      continue;
    }
    const generated = GENERATED_IMAGES_RE.exec(line);
    const attached = ATTACHED_RE.exec(line);
    if (generated) {
      images += Number(generated[1]);
      cursor -= 1;
      end = cursor;
    } else if (attached) {
      attachedCount += Number(attached[1]);
      files = [...pending, ...files];
      pending = [];
      cursor -= 1;
      end = cursor;
    } else if (FILE_ITEM_RE.test(line)) {
      pending = [line.replace(/^-\s+/, "").trim(), ...pending];
      cursor -= 1;
    } else {
      break;
    }
  }

  const prompt = lines.slice(0, end).join("\n").trim();
  const reply = replyToText(tail);
  const time = dateMatch ? htmlDateToIso(dateMatch) : undefined;
  const conversationId = CONVERSATION_RE.exec(chunk)?.[1] ?? `single-${index}`;
  const clippedPrompt = clip(prompt);
  const clippedReply = clip(reply);
  return {
    kind: "prompt",
    conversationId,
    exchange: {
      id: stableId("gemini", sourcePath, index, time, prompt.slice(0, 80)),
      time,
      prompt: clippedPrompt.text,
      response: reply ? clippedReply.text : undefined,
      promptChars: prompt.length,
      responseChars: reply.length,
      images,
      attachments: files.length ? files : Array.from({ length: attachedCount }, () => ""),
      truncated: clippedPrompt.clipped || clippedReply.clipped,
    },
  };
}

function ranked(map: Map<string, number>): GoogleRankedItem[] {
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function parseGemini(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void): Promise<GoogleGeminiSummary | undefined> {
  const files = entries.filter(isGeminiActivityFile);
  if (!files.length) return undefined;
  progress?.({ stage: "parsing", label: "Parsing Gemini conversations", percent: 94 });

  const warnings: string[] = [];
  const exchanges: { exchange: GoogleGeminiExchange; conversationId: string }[] = [];
  let parsedFiles = 0;
  let malformedEntries = 0;
  let otherEntries = 0;

  for (const entry of files) {
    try {
      const text = await readGoogleZipEntryText(entry);
      const chunks = text.split(OUTER_CELL).slice(1);
      chunks.forEach((chunk, index) => {
        const block = parseBlock(chunk, entry.path, index);
        if (block.kind === "prompt") exchanges.push({ exchange: block.exchange, conversationId: block.conversationId });
        else if (block.kind === "other") otherEntries += 1;
        else malformedEntries += 1;
      });
      parsedFiles += 1;
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse Gemini activity";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse Gemini activity."}`);
    }
  }
  if (!parsedFiles && !warnings.length) return undefined;

  const folder = entries.filter(isGeminiFolderFile);
  const folderFiles = { count: folder.length, bytes: folder.reduce((sum, item) => sum + item.uncompressedSize, 0) };

  const byMonth = new Map<string, number>();
  const byHour = new Map<string, number>();
  const byWeekday = new Map<string, number>();
  const byDay = new Map<string, number>();
  const attachmentTypes = new Map<string, number>();
  const lengths: number[] = [];
  let images = 0;
  let attachedFiles = 0;
  let withResponse = 0;
  for (const { exchange } of exchanges) {
    lengths.push(exchange.promptChars);
    images += exchange.images;
    attachedFiles += exchange.attachments.length;
    if (exchange.response) withResponse += 1;
    for (const name of exchange.attachments) {
      if (!name) continue;
      const extension = /\.([A-Za-z0-9]{1,6})$/.exec(name)?.[1]?.toLowerCase() ?? "(none)";
      attachmentTypes.set(extension, (attachmentTypes.get(extension) ?? 0) + 1);
    }
    if (!exchange.time) continue;
    const date = new Date(exchange.time);
    if (Number.isNaN(date.getTime())) continue;
    const month = exchange.time.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
    const hour = `${String(date.getUTCHours()).padStart(2, "0")}:00`;
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    byWeekday.set(WEEKDAYS[date.getUTCDay()], (byWeekday.get(WEEKDAYS[date.getUTCDay()]) ?? 0) + 1);
    byDay.set(exchange.time.slice(0, 10), (byDay.get(exchange.time.slice(0, 10)) ?? 0) + 1);
  }

  const sortedLengths = [...lengths].sort((a, b) => a - b);
  const promptLengths = LENGTH_BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    count: lengths.filter((value) => value < bucket.max && (index === 0 || value >= LENGTH_BUCKETS[index - 1].max)).length,
  }));

  const grouped = new Map<string, GoogleGeminiExchange[]>();
  const kept = [...exchanges].sort((a, b) => (b.exchange.time ?? "").localeCompare(a.exchange.time ?? "")).slice(0, EXCHANGE_LIMIT);
  for (const { exchange, conversationId } of exchanges) {
    const list = grouped.get(conversationId) ?? [];
    list.push(exchange);
    grouped.set(conversationId, list);
  }
  const keptIds = new Set(kept.map(({ exchange }) => exchange.id));
  const conversations: GoogleGeminiConversation[] = [...grouped.entries()].map(([id, list]) => {
    const chronological = list.filter((item) => keptIds.has(item.id)).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return {
      id,
      firstTime: chronological[0]?.time,
      lastTime: chronological[chronological.length - 1]?.time,
      images: chronological.reduce((sum, item) => sum + item.images, 0),
      attachmentCount: chronological.reduce((sum, item) => sum + item.attachments.length, 0),
      exchanges: chronological,
    };
  }).filter((conversation) => conversation.exchanges.length);
  conversations.sort((a, b) => (b.lastTime ?? "").localeCompare(a.lastTime ?? ""));

  const dayCounts = [...byDay.entries()].map(([date, count]) => ({ date, count } satisfies GoogleDayCount)).sort((a, b) => b.count - a.count || b.date.localeCompare(a.date));
  const times = exchanges.map(({ exchange }) => exchange.time).filter((value): value is string => Boolean(value)).sort();

  return {
    prompts: exchanges.length,
    conversations: grouped.size,
    withResponse,
    images,
    attachedFiles,
    otherEntries,
    parsedFiles,
    malformedEntries,
    warnings,
    dateRange: times.length ? { start: times[0], end: times[times.length - 1] } : undefined,
    byMonth: [...byMonth.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label)),
    byHour: Array.from({ length: 24 }, (_, hour) => {
      const label = `${String(hour).padStart(2, "0")}:00`;
      return { label, count: byHour.get(label) ?? 0 };
    }),
    byWeekday: WEEKDAYS.map((label) => ({ label, count: byWeekday.get(label) ?? 0 })),
    daily: [...dayCounts].sort((a, b) => a.date.localeCompare(b.date)),
    busiestDay: dayCounts[0],
    promptLengths,
    medianPromptChars: sortedLengths.length ? sortedLengths[Math.floor(sortedLengths.length / 2)] : 0,
    longestPromptChars: sortedLengths.length ? sortedLengths[sortedLengths.length - 1] : 0,
    longestConversationPrompts: Math.max(0, ...[...grouped.values()].map((list) => list.length)),
    attachmentTypes: ranked(attachmentTypes).slice(0, 12),
    folderFiles,
    conversationList: conversations.slice(0, CONVERSATION_LIMIT),
    conversationLimit: CONVERSATION_LIMIT,
    isConversationListCapped: conversations.length > CONVERSATION_LIMIT,
  };
}
