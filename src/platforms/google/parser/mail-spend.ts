import type { GoogleMailSpend, GoogleMailSpendMerchant, GoogleMailRepeatCharge, GoogleRankedItem } from "@/platforms/google/types";

// Order totals come from the text of order and receipt emails only. This module turns one raw message into plain text,
// finds the amount the shop says was paid, and rolls many of those up; it keeps no message text beyond the call.

const MERCHANT_LIMIT = 15;
const REPEAT_LIMIT = 10;
const MIN_REPEAT_MONTHS = 3;
const MAX_AMOUNT = 100_000;

const CURRENCY_SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP", $: "USD", "US$": "USD", "C$": "CAD", "A$": "AUD", lei: "RON", ron: "RON" };
const CURRENCY_CODES = "EUR|USD|GBP|RON|CAD|AUD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|BGN|JPY|INR";
const SYMBOL = "US\\$|C\\$|A\\$|€|£|\\$|lei|RON|" + CURRENCY_CODES;
const NUMBER = "\\d{1,3}(?:[.,\\s]\\d{3})*(?:[.,]\\d{2})|\\d+(?:[.,]\\d{1,2})?";
// A currency before the number ("€12.50", "EUR 12,50") or after it ("12,50 €", "12.50 EUR").
const AMOUNT_RE = new RegExp(`(?:(${SYMBOL})\\s?(${NUMBER}))|(?:(${NUMBER})\\s?(${SYMBOL})(?![A-Za-z]))`, "gi");

type LabelRule = { rank: number; pattern: RegExp };
// Lower rank wins. "Subtotal" never counts as a total.
const LABELS: LabelRule[] = [
  { rank: 1, pattern: /\b(total paid|amount paid|you paid|you['’]ve paid|paid in total|total charged|amount charged|payment amount|amount debited|paypal payment)\b/i },
  { rank: 2, pattern: /\b(order total|grand total|total due|invoice total|total cost|final cost|total gross|net total|total amount|total price|amount due|total to pay|total payable)\b/i },
  { rank: 3, pattern: /(?<![a-z-])total\b(?!\s*(items|savings|discount))/i },
];

export type OrderTotal = { amount: number; currency?: string; rank: number };

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(clean.length % 4 === 1 ? clean.slice(0, -1) : clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function decodeQuotedPrintable(text: string): Uint8Array {
  const joined = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const code = joined.charCodeAt(index);
    if (code === 61 && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(code & 0xff);
  }
  return Uint8Array.from(bytes);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// One character per byte. TextDecoder("latin1") is really windows-1252 in browsers, which remaps bytes 0x80 to 0x9F and would corrupt 8-bit bodies.
function bytesToBinaryString(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return result;
}

function splitHead(text: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: "" };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function headerValue(head: string, name: string): string {
  const match = new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im").exec(head);
  return match ? match[1].replace(/\r?\n[ \t]+/g, " ") : "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/[ \t ]+/g, " ");
}

// Walks the MIME tree and returns readable text: the plain-text part when there is one, otherwise the HTML part with its tags removed.
function textOfPart(raw: string, depth: number): { text: string; html: boolean } {
  const { head, body } = splitHead(raw);
  const type = headerValue(head, "Content-Type");
  const boundary = /boundary="?([^";\s]+)"?/i.exec(type)?.[1];
  if (/multipart\//i.test(type) && boundary && depth < 5) {
    let plain = "";
    let html = "";
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const child = part.replace(/^\r?\n/, "");
      const childHead = splitHead(child).head;
      if (/attachment/i.test(headerValue(childHead, "Content-Disposition"))) continue;
      const result = textOfPart(child, depth + 1);
      if (result.html) html += result.text;
      else plain += result.text;
    }
    return plain.trim() ? { text: plain, html: false } : { text: html, html: true };
  }
  const encoding = headerValue(head, "Content-Transfer-Encoding");
  const charset = /charset="?([^";\s]+)"?/i.exec(type)?.[1] ?? "utf-8";
  if (type && !/text\/(plain|html)/i.test(type)) return { text: "", html: false };
  // The message was read one byte per character, so 7bit and 8bit bodies go back to bytes the same way before the charset is applied.
  const bytes = /base64/i.test(encoding) ? decodeBase64(body) : /quoted-printable/i.test(encoding) ? decodeQuotedPrintable(body) : Uint8Array.from(body, (char) => char.charCodeAt(0) & 0xff);
  return { text: decodeBytes(bytes, charset), html: /text\/html/i.test(type) };
}

/** Plain text of a whole raw message (headers included), or an empty string if it holds no readable text part. */
export function extractMessageText(raw: Uint8Array): string {
  const { text, html } = textOfPart(bytesToBinaryString(raw), 0);
  return html ? htmlToText(text) : text;
}

export function parseAmount(value: string): number | undefined {
  const cleaned = value.replace(/\s/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Both separators: the one that comes last is the decimal point.
    normalised = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const parts = cleaned.split(separator);
    const tail = parts[parts.length - 1];
    // "12,50" and "12.5" are decimals; "1,250" and "1.250.000" are thousands groups.
    normalised = parts.length > 1 && tail.length === 3 && parts.slice(0, -1).every((part) => part.length <= 3 && part.length > 0) && !(parts.length === 2 && parts[0] === "0") ? parts.join("") : parts.slice(0, -1).join("") + "." + tail;
  } else normalised = cleaned;
  const amount = Number(normalised);
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT ? Math.round(amount * 100) / 100 : undefined;
}

function normaliseCurrency(symbol: string | undefined): string | undefined {
  if (!symbol) return undefined;
  return CURRENCY_SYMBOLS[symbol] ?? CURRENCY_SYMBOLS[symbol.toLowerCase()] ?? (new RegExp(`^(${CURRENCY_CODES})$`, "i").test(symbol) ? symbol.toUpperCase() : undefined);
}

function amountsIn(line: string): { amount: number; currency?: string }[] {
  const found: { amount: number; currency?: string }[] = [];
  for (const match of line.matchAll(AMOUNT_RE)) {
    const amount = parseAmount(match[2] ?? match[3]);
    if (amount !== undefined) found.push({ amount, currency: normaliseCurrency(match[1] ?? match[4]) });
  }
  return found;
}

/** The amount the shop says was paid or is due, from the strongest "total" label in the text. */
export function findOrderTotal(text: string): OrderTotal | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const messageCurrencies = new Map<string, number>();
  for (const line of lines) for (const item of amountsIn(line)) if (item.currency) messageCurrencies.set(item.currency, (messageCurrencies.get(item.currency) ?? 0) + 1);
  const dominant = [...messageCurrencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  let best: OrderTotal | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 400) continue;
    if (/sub\s?-?total/i.test(line)) continue;
    const rule = LABELS.find((candidate) => candidate.pattern.test(line));
    if (!rule) continue;
    let amounts = amountsIn(line);
    // A label alone on its line, with the amount on the next one.
    if (!amounts.length && index + 1 < lines.length && lines[index + 1].length < 40) amounts = amountsIn(lines[index + 1]);
    // "Total EUR 12.50" style: a bare number after the label with the currency named separately.
    if (!amounts.length) {
      const bare = new RegExp(`${rule.pattern.source}[^\\d]{0,12}(${NUMBER})\\s*(?:${CURRENCY_CODES})?\\s*$`, "i").exec(line);
      const value = bare ? parseAmount(bare[bare.length - 1]) : undefined;
      if (value !== undefined) amounts = [{ amount: value, currency: /\b(EUR|USD|GBP|RON)\b/i.exec(line)?.[1]?.toUpperCase() }];
    }
    if (!amounts.length) continue;
    const [first] = amounts;
    // Lower rank wins; among equals the later line wins, since the summary sits below the item list.
    if (!best || rule.rank <= best.rank) best = { amount: first.amount, currency: first.currency ?? dominant, rank: rule.rank };
  }
  return best;
}

export type SpendOrder = { domain: string; name?: string; ms?: number; amount: number; currency?: string };

function dayOf(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Rolls individual orders up. The same order often arrives as a confirmation and a receipt, so same shop, day, amount, and currency count once. */
export function buildSpend(orders: SpendOrder[], scanned: number, readable: number): GoogleMailSpend {
  const seen = new Set<string>();
  const unique: SpendOrder[] = [];
  for (const order of orders) {
    const key = `${order.domain}|${dayOf(order.ms) ?? ""}|${order.currency ?? ""}|${order.amount}`;
    if (order.ms !== undefined && seen.has(key)) continue;
    seen.add(key);
    unique.push(order);
  }

  const currencyTotals = new Map<string, { orders: number; total: number }>();
  let noCurrency = 0;
  for (const order of unique) {
    if (!order.currency) {
      noCurrency += 1;
      continue;
    }
    const entry = currencyTotals.get(order.currency) ?? { orders: 0, total: 0 };
    entry.orders += 1;
    entry.total += order.amount;
    currencyTotals.set(order.currency, entry);
  }
  const currencies = [...currencyTotals.entries()]
    .map(([currency, value]) => ({ currency, orders: value.orders, total: Math.round(value.total * 100) / 100 }))
    .sort((a, b) => b.orders - a.orders || b.total - a.total);
  const currency = currencies[0]?.currency;
  const main = unique.filter((order) => order.currency === currency);

  const byMonth = new Map<string, number>();
  const byYear = new Map<string, number>();
  const merchants = new Map<string, { names: Map<string, number>; orders: number; total: number; first?: number; last?: number; perMonth: Map<string, Map<number, number>> }>();
  for (const order of main) {
    const day = dayOf(order.ms);
    if (day) {
      byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + order.amount);
      byYear.set(day.slice(0, 4), (byYear.get(day.slice(0, 4)) ?? 0) + order.amount);
    }
    const merchant = merchants.get(order.domain) ?? { names: new Map<string, number>(), orders: 0, total: 0, perMonth: new Map<string, Map<number, number>>() };
    merchant.orders += 1;
    merchant.total += order.amount;
    if (order.name) merchant.names.set(order.name, (merchant.names.get(order.name) ?? 0) + 1);
    if (order.ms !== undefined) {
      if (merchant.first === undefined || order.ms < merchant.first) merchant.first = order.ms;
      if (merchant.last === undefined || order.ms > merchant.last) merchant.last = order.ms;
      const month = day!.slice(0, 7);
      const amounts = merchant.perMonth.get(month) ?? new Map<number, number>();
      amounts.set(order.amount, (amounts.get(order.amount) ?? 0) + 1);
      merchant.perMonth.set(month, amounts);
    }
    merchants.set(order.domain, merchant);
  }

  const toIso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
  const merchantRows: GoogleMailSpendMerchant[] = [...merchants.entries()]
    .map(([domain, value]) => ({
      domain,
      name: [...value.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
      orders: value.orders,
      total: Math.round(value.total * 100) / 100,
      average: Math.round((value.total / value.orders) * 100) / 100,
      first: toIso(value.first),
      last: toIso(value.last),
    }))
    .sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain));

  // A repeating charge: the same shop and the same amount in at least three different months.
  const repeating: GoogleMailRepeatCharge[] = [];
  for (const [domain, value] of merchants) {
    const monthsByAmount = new Map<number, string[]>();
    for (const [month, amounts] of value.perMonth) for (const amount of amounts.keys()) monthsByAmount.set(amount, [...(monthsByAmount.get(amount) ?? []), month]);
    const best = [...monthsByAmount.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0])[0];
    if (best && best[1].length >= MIN_REPEAT_MONTHS) {
      const months = [...best[1]].sort();
      repeating.push({ domain, name: [...value.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0], amount: best[0], months: months.length, first: months[0], last: months[months.length - 1] });
    }
  }
  repeating.sort((a, b) => b.amount * b.months - a.amount * a.months || a.domain.localeCompare(b.domain));

  const series = (map: Map<string, number>): GoogleRankedItem[] =>
    [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count: Math.round(count * 100) / 100 }));
  const biggest = [...main].sort((a, b) => b.amount - a.amount || (b.ms ?? 0) - (a.ms ?? 0))[0];
  const total = Math.round(main.reduce((sum, order) => sum + order.amount, 0) * 100) / 100;

  return {
    scanned,
    readable,
    orders: unique.length,
    duplicates: orders.length - unique.length,
    noCurrency,
    currencies,
    currency,
    total,
    average: main.length ? Math.round((total / main.length) * 100) / 100 : 0,
    biggest: biggest ? { domain: biggest.domain, name: biggest.name, date: toIso(biggest.ms), amount: biggest.amount } : undefined,
    byMonth: series(byMonth),
    byYear: series(byYear),
    merchants: merchantRows.slice(0, MERCHANT_LIMIT),
    merchantCount: merchantRows.length,
    repeating: repeating.slice(0, REPEAT_LIMIT),
  };
}
