import type {
  GoogleCalendarEvent,
  GoogleChatMessage,
  GoogleContact,
  GoogleMoreServices,
  GoogleParserProgress,
  GoogleRankedItem,
  GoogleSavedList,
  GoogleTask,
  GoogleTransaction,
} from "@/platforms/google/types";
import { readGoogleZipEntryText, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";

const LIST_CAP = 500;
const CHAT_CAP = 300;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const SMALL_PRODUCTS = new Set(["Contacts", "Calendar", "Tasks", "Saved", "Google Pay", "Google Chat", "Search Contributions", "Google Shopping"]);

function takeoutParts(entry: GoogleZipEntry): string[] {
  const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return index >= 0 ? parts.slice(index + 1) : parts;
}

function folderName(entry: GoogleZipEntry): string {
  const parts = takeoutParts(entry);
  return parts[parts.length - 2] ?? "unknown";
}

export function isSmallServiceFile(entry: GoogleZipEntry): boolean {
  if (!SMALL_PRODUCTS.has(entry.product)) return false;
  const name = entry.fileName.toLowerCase();
  const parts = takeoutParts(entry);
  switch (entry.product) {
    case "Contacts":
      return name.endsWith(".vcf");
    case "Calendar":
      return name.endsWith(".ics");
    case "Tasks":
      return name === "tasks.json";
    case "Saved":
      return name.endsWith(".csv");
    case "Google Pay":
      return name.endsWith(".csv") && parts.includes("Google transactions");
    case "Google Chat":
      return name === "messages.json" || name === "group_info.json" || name === "user_info.json";
    case "Search Contributions":
      return name === "reviews.json" || name === "thumbs.json";
    case "Google Shopping":
      return name.endsWith(".csv");
    default:
      return false;
  }
}

function increment(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function chronological(map: Map<string, number>): GoogleRankedItem[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function ranked(map: Map<string, number>, limit = 15): GoogleRankedItem[] {
  return [...map.entries()]
    .filter(([label]) => label.length > 0)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function iso(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rest] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((key) => key.trim());
  return rest.map((cells) => Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ""])));
}

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

type Prop = { name: string; params: string; value: string };

function parseProp(line: string): Prop | undefined {
  const colon = line.indexOf(":");
  if (colon < 1) return undefined;
  const head = line.slice(0, colon);
  const semi = head.indexOf(";");
  const rawName = (semi >= 0 ? head.slice(0, semi) : head).toUpperCase();
  return { name: rawName.includes(".") ? rawName.slice(rawName.indexOf(".") + 1) : rawName, params: semi >= 0 ? head.slice(semi + 1).toUpperCase() : "", value: line.slice(colon + 1) };
}

function icsDate(prop?: Prop): { iso?: string; allDay: boolean } {
  if (!prop) return { allDay: false };
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(prop.value.trim());
  if (!match) return { allDay: false };
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)));
  return { iso: Number.isNaN(date.getTime()) ? undefined : date.toISOString(), allDay: !h };
}

function parseContacts(text: string): GoogleContact[] {
  const contacts: GoogleContact[] = [];
  let current: { fn?: string; n?: string; org?: string; phones: string[]; emails: string[]; hasPhoto: boolean } | undefined;
  for (const line of unfold(text)) {
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VCARD") current = { phones: [], emails: [], hasPhoto: false };
    else if (prop.name === "END" && current) {
      const nameParts = (current.n ?? "").split(";");
      const composed = [nameParts[3], nameParts[1], nameParts[2], nameParts[0]].map((part) => part?.trim()).filter(Boolean).join(" ");
      contacts.push({
        name: current.fn?.trim() || composed || current.org?.trim() || current.emails[0] || current.phones[0] || "Unnamed contact",
        phones: current.phones,
        emails: current.emails,
        organization: current.org?.trim() || undefined,
        hasPhoto: current.hasPhoto,
      });
      current = undefined;
    } else if (current) {
      if (prop.name === "FN") current.fn = unescapeIcs(prop.value);
      else if (prop.name === "N") current.n = prop.value;
      else if (prop.name === "ORG") current.org = unescapeIcs(prop.value).replace(/;+/g, " ").trim();
      else if (prop.name === "TEL" && prop.value.trim()) current.phones.push(prop.value.trim());
      else if (prop.name === "EMAIL" && prop.value.trim()) current.emails.push(prop.value.trim());
      else if (prop.name === "PHOTO") current.hasPhoto = true;
    }
  }
  return contacts;
}

function parseCalendar(text: string): { name?: string; events: GoogleCalendarEvent[] } {
  const events: GoogleCalendarEvent[] = [];
  let name: string | undefined;
  let current: Prop[] | undefined;
  for (const line of unfold(text)) {
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value === "VEVENT") current = [];
    else if (prop.name === "END" && prop.value === "VEVENT" && current) {
      const find = (key: string) => current!.find((item) => item.name === key);
      const start = icsDate(find("DTSTART"));
      const end = icsDate(find("DTEND"));
      events.push({
        title: unescapeIcs(find("SUMMARY")?.value ?? "").trim() || "Untitled event",
        start: start.iso,
        end: end.iso,
        allDay: start.allDay,
        recurring: Boolean(find("RRULE")),
        location: unescapeIcs(find("LOCATION")?.value ?? "").trim() || undefined,
        attendees: current.filter((item) => item.name === "ATTENDEE").length,
        status: find("STATUS")?.value.trim() || undefined,
      });
      current = undefined;
    } else if (current) current.push(prop);
    else if (prop.name === "X-WR-CALNAME") name = unescapeIcs(prop.value);
  }
  return { name, events };
}

function parseLooseDate(text: string): string | undefined {
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:,|\s+at)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return undefined;
  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) return undefined;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAmount(text: string): { amount: number; currency?: string } {
  const match = /^\s*([A-Za-z]{3}|[^\d\s.,-]+)?[\s ]*(-?[\d.,]*\d)/.exec(text);
  if (!match) return { amount: 0 };
  const number = match[2].includes(",") && !/,\d{3}(\D|$)/.test(match[2]) ? match[2].replace(",", ".") : match[2].replace(/,/g, "");
  const amount = Number.parseFloat(number);
  return { amount: Number.isFinite(amount) ? amount : 0, currency: match[1] || undefined };
}

function collectTasks(list: Record<string, unknown>, listTitle: string, into: GoogleTask[]) {
  for (const value of asArray(list.items)) {
    const task = asRecord(value);
    if (!task) continue;
    if (str(task.kind)?.includes("taskList") || asArray(task.items).length) collectTasks(task, str(task.title) ?? listTitle, into);
    if (task.kind === "tasks#task" || task.status !== undefined || task.due !== undefined || task.notes !== undefined) {
      into.push({ title: str(task.title) ?? "Untitled task", list: listTitle, status: str(task.status), due: iso(task.due), updated: iso(task.updated), hasNotes: Boolean(str(task.notes)) });
    }
  }
}

export async function parseSmallServices(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void): Promise<GoogleMoreServices | undefined> {
  const files = entries.filter(isSmallServiceFile);
  if (!files.length) return undefined;
  progress?.({ stage: "parsing", label: "Parsing Contacts, Calendar, Pay, Chat, and other small services", percent: 92 });

  const warnings: string[] = [];
  const read = async (entry: GoogleZipEntry): Promise<string | undefined> => {
    try {
      return await readGoogleZipEntryText(entry);
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not read file";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not read file."}`);
      return undefined;
    }
  };
  const readJson = async (entry: GoogleZipEntry): Promise<unknown | undefined> => {
    const text = await read(entry);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse JSON";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse JSON."}`);
      return undefined;
    }
  };

  const result: GoogleMoreServices = { parsedFiles: 0, warnings };

  // Contacts
  const vcfFiles = files.filter((entry) => entry.product === "Contacts");
  if (vcfFiles.length) {
    // Takeout also writes per-device and per-label copies ("Device contacts - Samsung ...", "Starred in Android").
    // "All Contacts" is the union, so prefer it; without it, merge every file and drop repeats.
    const allContacts = vcfFiles.filter((entry) => takeoutParts(entry).includes("All Contacts"));
    const sourceFiles = allContacts.length ? allContacts : vcfFiles;
    const contacts: GoogleContact[] = [];
    const seen = new Set<string>();
    for (const entry of sourceFiles) {
      const text = await read(entry);
      if (text === undefined) continue;
      for (const contact of parseContacts(text)) {
        const key = `${contact.name}|${contact.phones.join(",")}|${contact.emails.join(",")}`;
        if (!allContacts.length && seen.has(key)) continue;
        seen.add(key);
        contacts.push(contact);
      }
    }
    const photoFiles = entries.filter((entry) => entry.product === "Contacts" && [".jpg", ".jpeg", ".png"].includes(entry.extension)).length;
    result.contacts = {
      total: contacts.length,
      withPhone: contacts.filter((c) => c.phones.length).length,
      withEmail: contacts.filter((c) => c.emails.length).length,
      withOrganization: contacts.filter((c) => c.organization).length,
      withPhoto: contacts.filter((c) => c.hasPhoto).length,
      photoFiles,
      exportFiles: vcfFiles.length,
      list: [...contacts].sort((a, b) => a.name.localeCompare(b.name)).slice(0, LIST_CAP),
      isCapped: contacts.length > LIST_CAP,
    };
  }

  // Calendar
  const icsFiles = files.filter((entry) => entry.product === "Calendar");
  if (icsFiles.length) {
    const events: GoogleCalendarEvent[] = [];
    const calendars: string[] = [];
    for (const entry of icsFiles) {
      const text = await read(entry);
      if (text === undefined) continue;
      const parsed = parseCalendar(text);
      events.push(...parsed.events);
      calendars.push(parsed.name ?? entry.fileName);
    }
    const byYear = new Map<string, number>();
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const event of events) {
      if (!event.start) continue;
      increment(byYear, event.start.slice(0, 4));
      const time = new Date(event.start).getTime();
      if (time < min) min = time;
      if (time > max) max = time;
    }
    result.calendar = {
      calendars,
      total: events.length,
      recurring: events.filter((e) => e.recurring).length,
      allDay: events.filter((e) => e.allDay).length,
      withAttendees: events.filter((e) => e.attendees > 0).length,
      withLocation: events.filter((e) => e.location).length,
      byYear: chronological(byYear),
      dateRange: Number.isFinite(min) ? { start: new Date(min).toISOString(), end: new Date(max).toISOString() } : undefined,
      list: [...events].sort((a, b) => (b.start ?? "").localeCompare(a.start ?? "")).slice(0, LIST_CAP),
      isCapped: events.length > LIST_CAP,
    };
  }

  // Tasks
  const taskFile = files.find((entry) => entry.product === "Tasks");
  if (taskFile) {
    const json = asRecord(await readJson(taskFile));
    if (json) {
      const tasks: GoogleTask[] = [];
      collectTasks(json, "Tasks", tasks);
      const lists = asArray(json.items).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
      result.tasks = {
        lists: lists.map((list) => str(list.title) ?? "Untitled list"),
        total: tasks.length,
        completed: tasks.filter((task) => task.status === "completed").length,
        list: tasks.slice(0, LIST_CAP),
      };
    }
  }

  // Saved
  const savedFiles = files.filter((entry) => entry.product === "Saved");
  if (savedFiles.length) {
    const lists: GoogleSavedList[] = [];
    for (const entry of savedFiles) {
      const text = await read(entry);
      if (text === undefined) continue;
      const items = csvRecords(text)
        .map((row) => ({ title: row.Title?.trim() || undefined, note: row.Note?.trim() || undefined, url: row.URL?.trim() || undefined }))
        .filter((item) => item.title || item.url);
      lists.push({ name: entry.fileName.replace(/\.csv$/i, ""), count: items.length, items: items.slice(0, 100) });
    }
    result.saved = { lists: lists.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), total: lists.reduce((sum, list) => sum + list.count, 0) };
  }

  // Google Pay
  const payFiles = files.filter((entry) => entry.product === "Google Pay");
  if (payFiles.length) {
    const transactions: GoogleTransaction[] = [];
    for (const entry of payFiles) {
      const text = await read(entry);
      if (text === undefined) continue;
      for (const row of csvRecords(text)) {
        if (!row["Transaction ID"] && !row.Amount) continue;
        const { amount, currency } = parseAmount(row.Amount ?? "");
        transactions.push({
          time: parseLooseDate(row.Time ?? ""),
          id: row["Transaction ID"] || undefined,
          description: row.Description?.trim() || "No description",
          product: row.Product?.trim() || undefined,
          paymentMethod: row["Payment method"]?.trim() || undefined,
          status: row.Status?.trim() || undefined,
          amount,
          currency,
        });
      }
    }
    const spend = new Map<string, { currency: string; total: number; count: number }>();
    const byProduct = new Map<string, number>();
    const byYear = new Map<string, number>();
    const byStatus = new Map<string, number>();
    for (const tx of transactions) {
      if (tx.status) increment(byStatus, tx.status);
      if (tx.product) increment(byProduct, tx.product);
      if (tx.time) increment(byYear, tx.time.slice(0, 4));
      if (tx.status === "Complete" && tx.amount > 0) {
        const key = tx.currency ?? "?";
        const entry = spend.get(key) ?? { currency: key, total: 0, count: 0 };
        entry.total += tx.amount;
        entry.count += 1;
        spend.set(key, entry);
      }
    }
    result.pay = {
      total: transactions.length,
      spend: [...spend.values()].sort((a, b) => b.total - a.total),
      byStatus: ranked(byStatus),
      byProduct: ranked(byProduct),
      byYear: chronological(byYear),
      list: [...transactions].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).slice(0, LIST_CAP),
      isCapped: transactions.length > LIST_CAP,
    };
  }

  // Google Chat
  const chatFiles = files.filter((entry) => entry.product === "Google Chat");
  if (chatFiles.length) {
    let selfEmail: string | undefined;
    const members = new Map<string, string[]>();
    for (const entry of chatFiles.filter((file) => file.fileName.toLowerCase() === "user_info.json")) {
      selfEmail ??= str(asRecord(asRecord(await readJson(entry))?.user)?.email)?.toLowerCase();
    }
    for (const entry of chatFiles.filter((file) => file.fileName.toLowerCase() === "group_info.json")) {
      const id = folderName(entry);
      const json = asRecord(await readJson(entry));
      members.set(id, asArray(json?.members).map((m) => str(asRecord(m)?.name) ?? str(asRecord(m)?.email) ?? "Unknown"));
    }
    const conversations: { id: string; members: string[]; messages: number; first?: string; last?: string }[] = [];
    const recent: GoogleChatMessage[] = [];
    const byYear = new Map<string, number>();
    let sent = 0;
    let received = 0;
    for (const entry of chatFiles.filter((file) => file.fileName.toLowerCase() === "messages.json")) {
      const id = folderName(entry);
      const json = asRecord(await readJson(entry));
      const messages = asArray(json?.messages).map(asRecord).filter((m): m is Record<string, unknown> => Boolean(m));
      let first: string | undefined;
      let last: string | undefined;
      for (const message of messages) {
        const creator = asRecord(message.creator);
        const time = parseLooseDate(str(message.created_date) ?? "");
        const isSelf = Boolean(selfEmail && str(creator?.email)?.toLowerCase() === selfEmail);
        if (isSelf) sent += 1;
        else received += 1;
        if (time) {
          increment(byYear, time.slice(0, 4));
          if (!first || time < first) first = time;
          if (!last || time > last) last = time;
        }
        recent.push({ conversation: id, sender: str(creator?.name) ?? str(creator?.email) ?? "Unknown", fromSelf: isSelf, time, text: str(message.text) ?? "" });
      }
      conversations.push({ id, members: members.get(id) ?? [], messages: messages.length, first, last });
    }
    result.chat = {
      conversations: conversations.sort((a, b) => b.messages - a.messages),
      messages: sent + received,
      sent,
      received,
      byYear: chronological(byYear),
      recent: recent.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).slice(0, CHAT_CAP),
      isCapped: recent.length > CHAT_CAP,
    };
  }

  // Search Contributions and Shopping reviews (counts only)
  const contributions = { reviews: 0, thumbs: 0, productReviews: 0, merchantReviews: 0, found: false };
  for (const entry of files.filter((file) => file.product === "Search Contributions")) {
    const json = await readJson(entry);
    if (!Array.isArray(json)) continue;
    contributions.found = true;
    if (entry.fileName.toLowerCase() === "reviews.json") contributions.reviews += json.length;
    else contributions.thumbs += json.length;
  }
  for (const entry of files.filter((file) => file.product === "Google Shopping")) {
    const text = await read(entry);
    if (text === undefined) continue;
    contributions.found = true;
    const rows = csvRecords(text).length;
    if (entry.path.includes("Merchant")) contributions.merchantReviews += rows;
    else contributions.productReviews += rows;
  }
  if (contributions.found) {
    result.contributions = { reviews: contributions.reviews, thumbs: contributions.thumbs, productReviews: contributions.productReviews, merchantReviews: contributions.merchantReviews };
  }

  result.parsedFiles = files.filter((entry) => entry.status === "parsed").length;
  return result;
}
