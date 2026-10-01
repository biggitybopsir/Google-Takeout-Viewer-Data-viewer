import type {
  GoogleDayCount,
  GoogleMailDomain,
  GoogleMailMerchant,
  GoogleMailSender,
  GoogleMailSpike,
  GoogleMailSummary,
  GoogleParserProgress,
  GoogleRankedItem,
} from "@/platforms/google/types";
import { indexGoogleZip, readGoogleZipEntryText, streamGoogleZipEntry, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import { buildSpend, extractMessageText, findOrderTotal, type SpendOrder } from "@/platforms/google/parser/mail-spend";

const TOP_SENDER_LIMIT = 30;
const TOP_DOMAIN_LIMIT = 25;
const SIZE_DOMAIN_LIMIT = 15;
const SUBSCRIPTION_LIMIT = 40;
const FOOTPRINT_LIMIT = 25;
const QUIET_MONTHS = 12;
const IGNORED_MIN_MESSAGES = 3;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Only headers the aggregates need are kept; the first occurrence of each wins. Bodies are never stored; the opt-in pass reads the text of order emails once and keeps only the amounts.
const WANTED_HEADERS = new Set(["from", "date", "subject", "x-gmail-labels", "x-gm-thrid", "list-unsubscribe", "list-id", "precedence", "auto-submitted", "delivered-to", "message-id"]);

const LARGEST_LIMIT = 15;
const EXTENSION_LIMIT = 12;
const MERCHANT_LIMIT = 15;
const STACK_MERCHANTS = 6;
const SECURITY_SOURCE_LIMIT = 10;
// Attachment bodies are base64 (about 4 bytes of text per 3 of file); sizes are estimated from line lengths, never decoded.
const BASE64_RATIO = 0.75;
// The opt-in body pass keeps at most this much of one order email, since its text comes before any big attachment.
const BODY_CAPTURE_BYTES = 600_000;

// Subjects are only read for classification; raw subjects are kept for the 15 largest messages and nowhere else.
const PURCHASE_SUBJECT = /\b(order (confirm\w*|received|placed|shipped|update|number|no\.?|#)|your order|order #\s*\d|receipt|invoice|payment (received|confirm\w*|successful)|thanks for your (order|purchase)|booking confirm\w*|has (been )?(shipped|dispatched|delivered)|dispatched|out for delivery|on its way|delivery (update|confirm\w*))\b/i;
const SHIPPING_SUBJECT = /\b(shipped|dispatched|out for delivery|on its way|delivered|delivery|tracking)\b/i;

const SECURITY_KINDS: { label: string; pattern: RegExp }[] = [
  { label: "Suspicious activity", pattern: /\b(suspicious|unusual|unrecogni[sz]ed|blocked|unauthori[sz]ed|was someone else|wasn'?t you|not you)\b/i },
  { label: "Password changes and resets", pattern: /\b(password)\b/i },
  { label: "Sign-in alerts", pattern: /\b(security alert|new (sign-?in|log-?in|device|location)|sign-?in (attempt|from)|signed in|logged in|log-?in (attempt|alert|notification))\b/i },
  { label: "Verification codes and 2-step", pattern: /\b(verification code|verify your|confirm your (email|account|identity)|one-time|security code|login code|sign-?in code|2-?step|two-?step|two-?factor|2fa|your code)\b/i },
];

const SYSTEM_LABELS = new Set(["inbox", "sent", "drafts", "spam", "trash", "bin", "starred", "important", "unread", "opened", "archived", "chat", "scheduled", "snoozed"]);

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "hotmail.co.uk", "outlook.ie", "eircom.net",
]);

const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "com.br", "com.mx", "co.za", "com.ar", "com.tr", "com.sg", "com.hk", "co.kr"]);

const NOREPLY_PATTERN = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|notifications?|notify|newsletter|bounce[s]?|alerts?)([-_.+@]|$)/i;

export function isMailFile(entry: GoogleZipEntry): boolean {
  if (entry.product !== "Mail") return false;
  const name = entry.fileName.toLowerCase();
  if (name.endsWith(".mbox")) return true;
  return name.endsWith(".json") && /(^|\/)user settings\//i.test(entry.path.replace(/\\/g, "/")) && ["filters.json", "blocked addresses.json", "forwarding addresses.json"].includes(name);
}

function asciiLower(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    const code = bytes[i];
    out += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return out;
}

const textDecoder = new TextDecoder("utf-8");

function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) return value;
  const collapsed = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return collapsed.replace(/=\?([\w-]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
    try {
      let bytes: Uint8Array;
      if (encoding.toLowerCase() === "b") {
        const binary = atob(text);
        bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } else {
        const raw = text.replace(/_/g, " ");
        const out: number[] = [];
        for (let i = 0; i < raw.length; i += 1) {
          if (raw[i] === "=" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
            out.push(parseInt(raw.slice(i + 1, i + 3), 16));
            i += 2;
          } else out.push(raw.charCodeAt(i) & 0xff);
        }
        bytes = Uint8Array.from(out);
      }
      try {
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return textDecoder.decode(bytes);
      }
    } catch {
      return whole;
    }
  });
}

function parseFrom(value: string | undefined): { address: string; name?: string } {
  if (!value) return { address: "unknown" };
  const angle = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].pop();
  const address = (angle?.[1] ?? value.match(/([^\s<>"',;]+@[^\s<>"',;]+)/)?.[1] ?? "").toLowerCase();
  if (!address) return { address: "unknown" };
  let name = angle ? value.slice(0, angle.index).trim() : "";
  name = decodeMimeWords(name.replace(/^"+|"+$/g, "").trim()).replace(/^"+|"+$/g, "").trim();
  return { address, name: name && name.toLowerCase() !== address ? name : undefined };
}

function parseLabels(value: string | undefined): string[] {
  if (!value) return [];
  const labels: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      labels.push(current);
      current = "";
    } else current += char;
  }
  labels.push(current);
  return labels.map((label) => decodeMimeWords(label.trim())).filter(Boolean);
}

function parseMailDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\([^)]*\)/g, "").trim();
  const time = Date.parse(cleaned);
  if (Number.isFinite(time)) return time;
  const withoutWeekday = cleaned.replace(/^[A-Za-z]{3},\s*/, "");
  const retry = Date.parse(withoutWeekday);
  return Number.isFinite(retry) ? retry : undefined;
}

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

type SenderAcc = {
  name?: string;
  count: number;
  bytes: number;
  first?: number;
  last?: number;
  opened: number;
  unread: number;
  automated: number;
  subscribed: number;
};

type MessageState = {
  started: boolean;
  inHeaders: boolean;
  prevBlank: boolean;
  headers: Record<string, string>;
  currentKey?: string;
  size: number;
  attachments: number;
  // 0 = not in an attachment part, 1 = reading its part headers, 2 = reading its (base64) data lines.
  attState: 0 | 1 | 2;
  attExt?: string;
  attBytes: number;
  lastWasContentType: boolean;
  lastContentTypeExt?: string;
  attachmentList: { extension: string; bytes: number }[];
  // Opt-in body pass only: raw lines of the message so far, kept while it could be an order email and dropped otherwise.
  capture: boolean;
  raw: Uint8Array[];
  rawBytes: number;
};

type LargeCandidate = { size: number; address: string; name?: string; ms?: number; attachments: number; subject?: string };

type MerchantAcc = { count: number; shipping: number; first?: number; last?: number; names: Map<string, number>; months: Map<string, number> };

// Pulls a file extension out of a filename= / name= parameter in a MIME header line.
function extensionFromHeader(text: string): string | undefined {
  const match = text.match(/name\*?(?:\d+\*)?=\s*(?:[\w-]*'[\w-]*')?"?([^";\r\n]*)/i);
  if (!match) return undefined;
  const value = match[1].trim().toLowerCase();
  const dot = value.lastIndexOf(".");
  const extension = dot >= 0 ? value.slice(dot + 1) : "";
  return /^[a-z0-9]{1,6}$/.test(extension) ? extension : "(none)";
}

function securityKind(subject: string): string | undefined {
  for (const kind of SECURITY_KINDS) if (kind.pattern.test(subject)) return kind.label;
  return undefined;
}

function isoDate(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function bump<K>(map: Map<K, number>, key: K, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function rankedFrom(map: Map<string, number>, limit: number): GoogleRankedItem[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function monthSeries(months: Map<string, number>): GoogleRankedItem[] {
  const keys = [...months.keys()].sort();
  if (!keys.length) return [];
  const series: GoogleRankedItem[] = [];
  let [year, month] = keys[0].split("-").map(Number);
  const [lastYear, lastMonth] = keys[keys.length - 1].split("-").map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    series.push({ label: key, count: months.get(key) ?? 0 });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return series;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Shared by the main scan and the body pass so both agree on what counts as automated mail.
function isAutomatedMessage(headers: Record<string, string>, fromAddress: string, lowerLabels: string[]): boolean {
  const precedence = (headers["precedence"] ?? "").toLowerCase();
  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  return (
    Boolean(headers["list-unsubscribe"]) ||
    Boolean(headers["list-id"]) ||
    ["bulk", "list", "junk"].includes(precedence) ||
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    NOREPLY_PATTERN.test(fromAddress.split("@")[0]) ||
    lowerLabels.some((label) => label.startsWith("category ") && label !== "category personal")
  );
}

// The same test the main scan uses to file a message under purchases, so the body pass reads exactly the emails the Purchases section counts.
function isPurchaseMessage(headers: Record<string, string>): boolean {
  const lowerLabels = parseLabels(headers["x-gmail-labels"]).map((label) => label.toLowerCase());
  if (lowerLabels.includes("sent")) return false;
  const from = parseFrom(headers["from"]);
  const domain = registrableDomain(from.address.includes("@") ? from.address.split("@")[1] : from.address);
  if (FREEMAIL.has(domain)) return false;
  const automated = isAutomatedMessage(headers, from.address, lowerLabels);
  const subject = headers["subject"] ? decodeMimeWords(headers["subject"]) : "";
  if ((automated || domain === "google.com") && securityKind(subject)) return false;
  return lowerLabels.includes("category purchases") || (automated && PURCHASE_SUBJECT.test(subject));
}

function emptySummary(): GoogleMailSummary {
  return {
    daily: [],
    parsedFiles: 0,
    malformedFiles: 0,
    warnings: [],
    mboxFiles: 0,
    duplicatesSkipped: 0,
    messages: 0,
    threads: 0,
    totalBytes: 0,
    undated: 0,
    sent: 0,
    received: 0,
    unread: 0,
    opened: 0,
    hasOpenedData: false,
    automated: 0,
    personal: 0,
    withAttachments: 0,
    unsubscribeMessages: 0,
    subscriptionSenders: 0,
    ignoredSubscriptionSenders: 0,
    ignoredSubscriptionMessages: 0,
    ignoredSubscriptionBytes: 0,
    uniqueSenders: 0,
    uniqueDomains: 0,
    byYear: [],
    byMonth: [],
    byWeekday: WEEKDAYS.map((label) => ({ label, count: 0 })),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0"), count: 0 })),
    spikes: [],
    labels: [],
    userLabels: [],
    topSenders: [],
    topDomains: [],
    topDomainsBySize: [],
    subscriptions: [],
    footprint: { accountDomains: 0, quietMonths: QUIET_MONTHS, newDomainsByYear: [], oldest: [], quiet: [] },
    storage: { attachmentCount: 0, attachmentBytes: 0, attachmentShare: 0, byType: [], largest: [] },
    purchases: { messages: 0, labelled: 0, subjectOnly: 0, shipping: 0, merchantCount: 0, merchants: [], stackMerchants: [], months: [] },
    security: { messages: 0, byKind: [], byMonth: [], topSources: [], passwordServices: 0 },
  };
}

export type MailParseOptions = { bodies?: boolean };

export async function parseMail(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void, options: MailParseOptions = {}): Promise<GoogleMailSummary | undefined> {
  const files = entries.filter(isMailFile);
  if (!files.length) return undefined;
  const mboxFiles = files.filter((entry) => entry.fileName.toLowerCase().endsWith(".mbox"));
  const settingsFiles = files.filter((entry) => !mboxFiles.includes(entry));

  const result = emptySummary();
  result.mboxFiles = mboxFiles.length;
  const warnings = result.warnings;

  const senders = new Map<string, SenderAcc>();
  const threads = new Set<string>();
  const seenIds = mboxFiles.length > 1 ? new Set<string>() : undefined;
  const monthCounts = new Map<string, number>();
  const monthSenders = new Map<string, Map<string, number>>();
  const dayCounts = new Map<string, number>();
  const yearCounts = new Map<string, number>();
  const weekdayCounts = new Array<number>(7).fill(0);
  const hourCounts = new Array<number>(24).fill(0);
  const systemLabelCounts = new Map<string, number>();
  const userLabelCounts = new Map<string, number>();
  const deliveredTo = new Map<string, number>();
  let firstMs: number | undefined;
  let lastMs: number | undefined;

  const state: MessageState = { started: false, inHeaders: false, prevBlank: true, headers: {}, size: 0, attachments: 0, attState: 0, attBytes: 0, lastWasContentType: false, attachmentList: [], capture: false, raw: [], rawBytes: 0 };

  const spendOrders: SpendOrder[] = [];
  let spendScanned = 0;
  let spendReadable = 0;

  const extensionStats = new Map<string, { count: number; bytes: number }>();
  let attachmentCount = 0;
  let attachmentBytes = 0;
  const largest: LargeCandidate[] = [];
  const merchants = new Map<string, MerchantAcc>();
  const purchaseMonths = new Map<string, Map<string, number>>();
  let purchaseMessages = 0;
  let purchaseLabelled = 0;
  let purchaseShipping = 0;
  const securityKindCounts = new Map<string, number>();
  const securityMonths = new Map<string, number>();
  const securitySources = new Map<string, number>();
  const passwordDomains = new Set<string>();
  let securityMessages = 0;
  let securityFirst: number | undefined;
  let securityLast: number | undefined;

  const finishAttachment = () => {
    if (state.attState === 0) return;
    state.attachmentList.push({ extension: state.attExt ?? "(unknown)", bytes: Math.round(state.attBytes * BASE64_RATIO) });
    state.attState = 0;
    state.attExt = undefined;
    state.attBytes = 0;
  };

  const flushMessage = () => {
    if (!state.started) return;
    finishAttachment();
    const headers = state.headers;
    const messageId = headers["message-id"];
    if (seenIds && messageId) {
      if (seenIds.has(messageId)) {
        result.duplicatesSkipped += 1;
        return;
      }
      seenIds.add(messageId);
    }
    result.messages += 1;
    result.totalBytes += state.size;
    if (headers["x-gm-thrid"]) threads.add(headers["x-gm-thrid"]);
    if (state.attachments > 0) result.withAttachments += 1;
    if (headers["delivered-to"]) bump(deliveredTo, headers["delivered-to"].toLowerCase().replace(/^<|>$/g, ""));

    const labels = parseLabels(headers["x-gmail-labels"]);
    const lowerLabels = labels.map((label) => label.toLowerCase());
    for (const label of labels) {
      const lower = label.toLowerCase();
      if (SYSTEM_LABELS.has(lower) || lower.startsWith("category ")) bump(systemLabelCounts, label);
      else bump(userLabelCounts, label);
    }
    const isSent = lowerLabels.includes("sent");
    const isOpened = lowerLabels.includes("opened");
    const isUnread = lowerLabels.includes("unread");
    if (isOpened) result.opened += 1;
    if (isUnread) result.unread += 1;

    const ms = parseMailDate(headers["date"]);
    let monthKey: string | undefined;
    if (ms === undefined) result.undated += 1;
    else {
      const date = new Date(ms);
      monthKey = monthKeyOf(date);
      bump(monthCounts, monthKey);
      bump(dayCounts, dayKeyOf(date));
      bump(yearCounts, String(date.getFullYear()));
      weekdayCounts[date.getDay()] += 1;
      hourCounts[date.getHours()] += 1;
      if (firstMs === undefined || ms < firstMs) firstMs = ms;
      if (lastMs === undefined || ms > lastMs) lastMs = ms;
    }

    const from = parseFrom(headers["from"]);

    // Storage: estimated attachment sizes by type, and the largest messages (only these keep their subject).
    for (const attachment of state.attachmentList) {
      attachmentCount += 1;
      attachmentBytes += attachment.bytes;
      const stats = extensionStats.get(attachment.extension) ?? { count: 0, bytes: 0 };
      stats.count += 1;
      stats.bytes += attachment.bytes;
      extensionStats.set(attachment.extension, stats);
    }
    if (largest.length < LARGEST_LIMIT || state.size > largest[largest.length - 1].size) {
      largest.push({ size: state.size, address: from.address, name: from.name, ms, attachments: state.attachmentList.length, subject: headers["subject"] ? decodeMimeWords(headers["subject"]).trim() : undefined });
      largest.sort((a, b) => b.size - a.size);
      if (largest.length > LARGEST_LIMIT) largest.pop();
    }

    if (isSent) {
      result.sent += 1;
      return;
    }

    const hasUnsubscribe = Boolean(headers["list-unsubscribe"]);
    const isList = hasUnsubscribe || Boolean(headers["list-id"]);
    const automated = isAutomatedMessage(headers, from.address, lowerLabels);
    if (hasUnsubscribe) result.unsubscribeMessages += 1;
    if (automated) result.automated += 1;
    else result.personal += 1;

    const acc = senders.get(from.address) ?? { count: 0, bytes: 0, opened: 0, unread: 0, automated: 0, subscribed: 0 };
    if (from.name && !acc.name) acc.name = from.name;
    acc.count += 1;
    acc.bytes += state.size;
    if (isOpened) acc.opened += 1;
    if (isUnread) acc.unread += 1;
    if (automated) acc.automated += 1;
    if (isList) acc.subscribed += 1;
    if (ms !== undefined) {
      if (acc.first === undefined || ms < acc.first) acc.first = ms;
      if (acc.last === undefined || ms > acc.last) acc.last = ms;
    }
    senders.set(from.address, acc);
    if (monthKey) {
      const perMonth = monthSenders.get(monthKey) ?? new Map<string, number>();
      bump(perMonth, from.address);
      monthSenders.set(monthKey, perMonth);
    }

    // Security trail and purchases are classified from sender, Gmail's own labels, and the subject line.
    const host = from.address.includes("@") ? from.address.split("@")[1] : from.address;
    const domain = registrableDomain(host);
    const subject = headers["subject"] ? decodeMimeWords(headers["subject"]) : "";
    const kind = automated || domain === "google.com" ? securityKind(subject) : undefined;
    if (kind && !FREEMAIL.has(domain)) {
      securityMessages += 1;
      bump(securityKindCounts, kind);
      bump(securitySources, domain);
      if (kind === "Password changes and resets") passwordDomains.add(domain);
      if (monthKey) bump(securityMonths, monthKey);
      if (ms !== undefined) {
        if (securityFirst === undefined || ms < securityFirst) securityFirst = ms;
        if (securityLast === undefined || ms > securityLast) securityLast = ms;
      }
      return;
    }
    const labelPurchase = lowerLabels.includes("category purchases");
    const subjectPurchase = automated && PURCHASE_SUBJECT.test(subject);
    if ((labelPurchase || subjectPurchase) && !FREEMAIL.has(domain)) {
      purchaseMessages += 1;
      if (labelPurchase) purchaseLabelled += 1;
      const shipping = SHIPPING_SUBJECT.test(subject);
      if (shipping) purchaseShipping += 1;
      const merchant = merchants.get(domain) ?? { count: 0, shipping: 0, names: new Map<string, number>(), months: new Map<string, number>() };
      merchant.count += 1;
      if (shipping) merchant.shipping += 1;
      if (from.name) bump(merchant.names, from.name);
      if (monthKey) {
        bump(merchant.months, monthKey);
        const perMonth = purchaseMonths.get(monthKey) ?? new Map<string, number>();
        bump(perMonth, domain);
        purchaseMonths.set(monthKey, perMonth);
      }
      if (ms !== undefined) {
        if (merchant.first === undefined || ms < merchant.first) merchant.first = ms;
        if (merchant.last === undefined || ms > merchant.last) merchant.last = ms;
      }
      merchants.set(domain, merchant);

      if (state.capture && state.raw.length) {
        spendScanned += 1;
        const raw = new Uint8Array(state.rawBytes);
        let offset = 0;
        for (const line of state.raw) {
          raw.set(line, offset);
          offset += line.length;
        }
        const text = extractMessageText(raw);
        if (text.trim().length >= 20) {
          spendReadable += 1;
          const total = findOrderTotal(text);
          if (total) spendOrders.push({ domain, name: from.name, ms, amount: total.amount, currency: total.currency });
        }
      }
    }
  };

  const handleLine = (bytes: Uint8Array, start: number, end: number) => {
    let contentEnd = end;
    if (contentEnd > start && bytes[contentEnd - 1] === 13) contentEnd -= 1;
    const length = contentEnd - start;

    if (length >= 5 && state.prevBlank && bytes[start] === 70 && bytes[start + 1] === 114 && bytes[start + 2] === 111 && bytes[start + 3] === 109 && bytes[start + 4] === 32) {
      flushMessage();
      state.started = true;
      state.inHeaders = true;
      state.prevBlank = false;
      state.headers = {};
      state.currentKey = undefined;
      state.attachments = 0;
      state.attState = 0;
      state.attExt = undefined;
      state.attBytes = 0;
      state.lastWasContentType = false;
      state.lastContentTypeExt = undefined;
      state.attachmentList = [];
      state.capture = false;
      state.raw = [];
      state.rawBytes = 0;
      state.size = end - start + 1;
      return;
    }
    if (!state.started) return;
    state.size += end - start + 1;
    state.prevBlank = length === 0;

    if (options.bodies && state.inHeaders && state.rawBytes < BODY_CAPTURE_BYTES) {
      const copy = new Uint8Array(contentEnd - start + 1);
      copy.set(bytes.subarray(start, contentEnd), 0);
      copy[copy.length - 1] = 10;
      state.raw.push(copy);
      state.rawBytes += copy.length;
    }

    if (state.inHeaders) {
      if (length === 0) {
        state.inHeaders = false;
        if (options.bodies) {
          state.capture = isPurchaseMessage(state.headers);
          if (!state.capture) {
            state.raw = [];
            state.rawBytes = 0;
          }
        }
        return;
      }
      const first = bytes[start];
      if (first === 32 || first === 9) {
        if (state.currentKey) state.headers[state.currentKey] += ` ${textDecoder.decode(bytes.subarray(start, contentEnd)).trim()}`;
        return;
      }
      let colon = -1;
      const scanEnd = Math.min(contentEnd, start + 40);
      for (let i = start; i < scanEnd; i += 1) {
        if (bytes[i] === 58) {
          colon = i;
          break;
        }
      }
      if (colon < 0) {
        state.currentKey = undefined;
        return;
      }
      const key = asciiLower(bytes, start, colon);
      if (!WANTED_HEADERS.has(key) || key in state.headers) {
        state.currentKey = undefined;
        return;
      }
      state.headers[key] = textDecoder.decode(bytes.subarray(colon + 1, contentEnd)).trim();
      state.currentKey = key;
      return;
    }

    // Body lines are skipped unless the opt-in body pass is on and the message looks like an order email, in which case
    // its lines are buffered (up to a cap) and read once when the message ends. Otherwise the scan only tracks MIME part
    // headers to find attachments (type from the filename, size from the length of the base64 lines that follow).
    if (state.capture && state.rawBytes < BODY_CAPTURE_BYTES) {
      const copy = new Uint8Array(contentEnd - start + 1);
      copy.set(bytes.subarray(start, contentEnd), 0);
      copy[copy.length - 1] = 10;
      state.raw.push(copy);
      state.rawBytes += copy.length;
    }
    const first = bytes[start];
    if (state.attState === 2) {
      if (length >= 2 && first === 45 && bytes[start + 1] === 45) finishAttachment();
      else {
        state.attBytes += length + 1;
        return;
      }
    } else if (state.attState === 1) {
      if (length === 0) {
        state.attState = 2;
        return;
      }
      if (!state.attExt && (first === 32 || first === 9 || (first | 32) === 99)) state.attExt = extensionFromHeader(textDecoder.decode(bytes.subarray(start, Math.min(contentEnd, start + 200))));
      return;
    }
    if (length >= 2 && first === 45 && bytes[start + 1] === 45) {
      state.lastWasContentType = false;
      state.lastContentTypeExt = undefined;
      return;
    }
    if ((first === 32 || first === 9) && state.lastWasContentType && !state.lastContentTypeExt) {
      state.lastContentTypeExt = extensionFromHeader(textDecoder.decode(bytes.subarray(start, Math.min(contentEnd, start + 200))));
      return;
    }
    if (length >= 14 && (first | 32) === 99) {
      const head = asciiLower(bytes, start, start + 20);
      if (head.startsWith("content-type:")) {
        state.lastWasContentType = true;
        state.lastContentTypeExt = extensionFromHeader(textDecoder.decode(bytes.subarray(start, Math.min(contentEnd, start + 200))));
        return;
      }
      if (head === "content-disposition:") {
        const text = textDecoder.decode(bytes.subarray(start + 20, Math.min(contentEnd, start + 200)));
        if (/attachment/i.test(text)) {
          state.attachments += 1;
          state.attState = 1;
          state.attExt = extensionFromHeader(text) ?? state.lastContentTypeExt;
          state.attBytes = 0;
        }
      }
    }
    state.lastWasContentType = false;
  };

  let carry: Uint8Array | undefined;
  const pushChunk = (chunk: Uint8Array) => {
    let data = chunk;
    if (carry && carry.length) {
      data = new Uint8Array(carry.length + chunk.length);
      data.set(carry, 0);
      data.set(chunk, carry.length);
      carry = undefined;
    }
    let position = 0;
    while (position < data.length) {
      const newline = data.indexOf(10, position);
      if (newline === -1) {
        carry = data.slice(position);
        return;
      }
      handleLine(data, position, newline);
      position = newline + 1;
    }
  };

  const totalCompressed = mboxFiles.reduce((sum, entry) => sum + entry.compressedSize, 0) || 1;
  let completedCompressed = 0;
  for (const entry of mboxFiles) {
    state.started = false;
    state.inHeaders = false;
    state.prevBlank = true;
    carry = undefined;
    try {
      await streamGoogleZipEntry(entry, pushChunk, (consumed) => {
        const fraction = (completedCompressed + consumed) / totalCompressed;
        progress?.({
          stage: "parsing",
          label: `Scanning Gmail mailbox: ${Math.round(fraction * 100)}% (${result.messages.toLocaleString("en")} messages so far)`,
          percent: 89 + fraction * 2,
        });
      });
      if (carry && (carry as Uint8Array).length) handleLine(carry, 0, (carry as Uint8Array).length);
      carry = undefined;
      flushMessage();
      state.started = false;
      result.parsedFiles += 1;
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not read mailbox";
      result.malformedFiles += 1;
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not read mailbox."}`);
    }
    completedCompressed += entry.compressedSize;
  }

  for (const entry of settingsFiles) {
    try {
      const parsed = JSON.parse(await readGoogleZipEntryText(entry)) as { filter?: unknown[]; addresses?: unknown[] };
      const settings = result.settings ?? { filters: 0, blockedAddresses: 0, forwardingAddresses: 0 };
      const name = entry.fileName.toLowerCase();
      if (name === "filters.json") settings.filters = Array.isArray(parsed.filter) ? parsed.filter.length : 0;
      else if (name === "blocked addresses.json") settings.blockedAddresses = Array.isArray(parsed.addresses) ? parsed.addresses.length : 0;
      else settings.forwardingAddresses = Array.isArray(parsed.addresses) ? parsed.addresses.length : 0;
      result.settings = settings;
      result.parsedFiles += 1;
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse JSON";
      result.malformedFiles += 1;
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse JSON."}`);
    }
  }

  if (!result.messages) return result;

  if (options.bodies) result.spend = buildSpend(spendOrders, spendScanned, spendReadable);
  result.threads = threads.size;
  result.received = result.messages - result.sent;
  result.hasOpenedData = result.opened > 0;
  result.dateRange = firstMs !== undefined && lastMs !== undefined ? { start: isoDate(firstMs)!, end: isoDate(lastMs)! } : undefined;
  result.account = [...deliveredTo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  result.byYear = [...yearCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }));
  result.byMonth = monthSeries(monthCounts);
  result.byWeekday = WEEKDAYS.map((label, index) => ({ label, count: weekdayCounts[index] }));
  result.byHour = hourCounts.map((count, hour) => ({ label: String(hour).padStart(2, "0"), count }));
  const busiest = [...dayCounts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  result.daily = [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
  result.busiestDay = busiest ? ({ date: busiest[0], count: busiest[1] } satisfies GoogleDayCount) : undefined;
  result.labels = rankedFrom(systemLabelCounts, 20);
  result.userLabels = rankedFrom(userLabelCounts, 15);

  const monthlyValues = [...monthCounts.values()];
  const spikeFloor = Math.max(40, median(monthlyValues) * 2.5);
  const spikes: GoogleMailSpike[] = [];
  for (const [month, count] of monthCounts) {
    if (count < spikeFloor) continue;
    const top = [...(monthSenders.get(month) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0];
    spikes.push({ month, count, topSender: top?.[0], topSenderCount: top?.[1] });
  }
  result.spikes = spikes.sort((a, b) => b.count - a.count).slice(0, 6);

  // Sender and domain tables.
  const senderRows: GoogleMailSender[] = [];
  const domainAccs = new Map<string, { count: number; bytes: number; senders: number; first?: number; last?: number; automated: number }>();
  let subscriptionSenders = 0;
  let ignoredSenders = 0;
  let ignoredMessages = 0;
  let ignoredBytes = 0;
  for (const [address, acc] of senders) {
    const host = address.includes("@") ? address.split("@")[1] : address;
    const subscription = acc.subscribed / acc.count >= 0.5;
    const ignored = result.hasOpenedData && subscription && acc.opened === 0 && acc.count >= IGNORED_MIN_MESSAGES;
    if (subscription) subscriptionSenders += 1;
    if (ignored) {
      ignoredSenders += 1;
      ignoredMessages += acc.count;
      ignoredBytes += acc.bytes;
    }
    senderRows.push({
      address,
      name: acc.name,
      domain: registrableDomain(host),
      count: acc.count,
      bytes: acc.bytes,
      firstDate: isoDate(acc.first),
      lastDate: isoDate(acc.last),
      opened: acc.opened,
      unread: acc.unread,
      kind: acc.automated / acc.count >= 0.5 ? "automated" : "personal",
      subscription,
      ignored,
    });
    const domain = registrableDomain(host);
    const dom = domainAccs.get(domain) ?? { count: 0, bytes: 0, senders: 0, automated: 0 };
    dom.count += acc.count;
    dom.bytes += acc.bytes;
    dom.senders += 1;
    dom.automated += acc.automated;
    if (acc.first !== undefined && (dom.first === undefined || acc.first < dom.first)) dom.first = acc.first;
    if (acc.last !== undefined && (dom.last === undefined || acc.last > dom.last)) dom.last = acc.last;
    domainAccs.set(domain, dom);
  }
  const domainRows: GoogleMailDomain[] = [...domainAccs.entries()].map(([domain, dom]) => ({
    domain,
    count: dom.count,
    bytes: dom.bytes,
    senders: dom.senders,
    firstDate: isoDate(dom.first),
    lastDate: isoDate(dom.last),
    kind: dom.automated / dom.count >= 0.5 ? "automated" : "personal",
  }));

  result.uniqueSenders = senderRows.length;
  result.uniqueDomains = domainRows.length;
  result.subscriptionSenders = subscriptionSenders;
  result.ignoredSubscriptionSenders = ignoredSenders;
  result.ignoredSubscriptionMessages = ignoredMessages;
  result.ignoredSubscriptionBytes = ignoredBytes;
  result.topSenders = [...senderRows].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address)).slice(0, TOP_SENDER_LIMIT);
  result.topDomains = [...domainRows].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)).slice(0, TOP_DOMAIN_LIMIT);
  result.topDomainsBySize = [...domainRows].sort((a, b) => b.bytes - a.bytes || a.domain.localeCompare(b.domain)).slice(0, SIZE_DOMAIN_LIMIT);
  result.subscriptions = senderRows
    .filter((row) => row.subscription)
    .sort((a, b) => Number(b.ignored) - Number(a.ignored) || b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, SUBSCRIPTION_LIMIT);

  // Account footprint: automated (service) domains that are not personal mail providers. One-off senders are skipped.
  const accountDomains = domainRows.filter((row) => row.kind === "automated" && !FREEMAIL.has(row.domain) && row.firstDate && row.lastDate);
  const newestMs = lastMs ?? 0;
  const quietCutoff = newestMs - QUIET_MONTHS * 30.4375 * 86_400_000;
  const established = accountDomains.filter((row) => row.count >= 2);
  const newDomains = new Map<string, number>();
  for (const row of established) bump(newDomains, String(new Date(row.firstDate!).getFullYear()));
  result.footprint = {
    accountDomains: established.length,
    quietMonths: QUIET_MONTHS,
    newDomainsByYear: [...newDomains.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count })),
    oldest: [...established].sort((a, b) => a.firstDate!.localeCompare(b.firstDate!) || b.count - a.count).slice(0, FOOTPRINT_LIMIT),
    quiet: established
      .filter((row) => row.count >= 3 && Date.parse(row.lastDate!) < quietCutoff)
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
      .slice(0, FOOTPRINT_LIMIT),
  };

  // Storage.
  result.storage = {
    attachmentCount,
    attachmentBytes,
    attachmentShare: result.totalBytes ? attachmentBytes / result.totalBytes : 0,
    byType: [...extensionStats.entries()]
      .map(([extension, stats]) => ({ extension, count: stats.count, bytes: stats.bytes }))
      .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.extension.localeCompare(b.extension))
      .slice(0, EXTENSION_LIMIT),
    largest: largest.map((item) => ({
      sender: item.address,
      name: item.name,
      date: isoDate(item.ms),
      bytes: item.size,
      attachments: item.attachments,
      subject: item.subject || undefined,
    })),
  };

  // Purchases and deliveries, per merchant and per month.
  const merchantRows: GoogleMailMerchant[] = [...merchants.entries()].map(([domain, merchant]) => {
    const peak = [...merchant.months.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const name = [...merchant.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      domain,
      name,
      count: merchant.count,
      shipping: merchant.shipping,
      firstDate: isoDate(merchant.first),
      lastDate: isoDate(merchant.last),
      activeMonths: merchant.months.size,
      peakMonth: peak?.[0],
      peakCount: peak?.[1],
    };
  });
  merchantRows.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  const stackMerchants = merchantRows.slice(0, STACK_MERCHANTS).map((row) => row.domain);
  const purchaseSeries = monthSeries(new Map([...purchaseMonths.entries()].map(([month, perMonth]) => [month, [...perMonth.values()].reduce((sum, count) => sum + count, 0)])));
  result.purchases = {
    messages: purchaseMessages,
    labelled: purchaseLabelled,
    subjectOnly: purchaseMessages - purchaseLabelled,
    shipping: purchaseShipping,
    merchantCount: merchantRows.length,
    merchants: merchantRows.slice(0, MERCHANT_LIMIT),
    stackMerchants,
    months: purchaseSeries.map((item) => {
      const perMonth = purchaseMonths.get(item.label);
      const byMerchant: Record<string, number> = {};
      for (const domain of stackMerchants) {
        const count = perMonth?.get(domain);
        if (count) byMerchant[domain] = count;
      }
      return { label: item.label, total: item.count, byMerchant };
    }),
  };

  // Security trail.
  result.security = {
    messages: securityMessages,
    byKind: rankedFrom(securityKindCounts, 10),
    byMonth: monthSeries(securityMonths),
    topSources: rankedFrom(securitySources, SECURITY_SOURCE_LIMIT),
    passwordServices: passwordDomains.size,
    firstDate: isoDate(securityFirst),
    lastDate: isoDate(securityLast),
  };

  return result;
}

/** The opt-in pass: scans the same mailbox again and also reads the text of order and receipt emails to find order totals. */
export async function parseMailWithBodies(files: File[], progress?: (progress: GoogleParserProgress) => void): Promise<GoogleMailSummary | undefined> {
  const entries: GoogleZipEntry[] = [];
  for (const file of files) entries.push(...(await indexGoogleZip(file)).entries);
  return parseMail(entries, progress, { bodies: true });
}
