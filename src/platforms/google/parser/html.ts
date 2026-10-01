// Shared helpers for reading the HTML that Google Takeout writes for My Activity style files.

export const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export const HTML_DATE_RE = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(?:[A-Z]{2,5}|GMT[+-]\d{1,2})/;

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&emsp;|&#8195;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

export function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\u00a0/g, " ");
}

export function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function htmlDateToIso(match: RegExpExecArray): string | undefined {
  const [, day, monthName, year, hour, minute, second] = match;
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  return new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
}

export function stableId(...parts: (string | number | undefined)[]): string {
  let hash = 2166136261;
  for (const char of parts.filter(Boolean).join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
