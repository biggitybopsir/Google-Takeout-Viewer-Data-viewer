"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, AlertTriangle, Archive, CalendarDays, Check, ChevronDown, Database, EyeOff, FileWarning, Flame, FolderTree, Footprints, Gamepad2, Globe, HardDrive, HeartPulse, Image as ImageIcon, Inbox, Layers, LayoutDashboard, LayoutGrid, Loader2, LockKeyhole, Mail, MapPin, PlayCircle, Route, Search, ShieldCheck, ShoppingBag, Smartphone, Sparkles, Timer, TrendingUp, Users } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import type { GoogleActivityEntry, GoogleChromeDevice, GoogleChromeHistoryEntry, GoogleCoverageStatus, GoogleFitDay, GoogleGeminiConversation, GoogleMailDomain, GoogleMailSender, GoogleMailSpend, GoogleMailSummary, GooglePhotosEntry, GooglePlayGame, GooglePlayInstall, GooglePlayPurchase, GoogleRankedItem, GoogleSectionKey, GoogleSectionStatus, GoogleUnpackedData } from "@/platforms/google/types";
import { buildGoogleRecap, type GoogleRecap, type GoogleRecapDay, type GoogleRecapSourceKey } from "@/platforms/google/recap";
import type { YouTubeSearchEntry, YouTubeWatchEntry } from "@/platforms/youtube/types";

// Lets the Gmail tab ask the page to run the opt-in pass that reads order emails; absent when there is no upload to re-read (the demo).
export type MailBodiesControl = {
  status: "idle" | "running" | "failed";
  label: string;
  percent: number;
  error?: string;
  onStart: () => void;
};

// Progress of the sections being read in the background after the dashboard opened, and a way to retry one that failed.
export type SectionsControl = {
  status: Partial<Record<GoogleSectionKey, GoogleSectionStatus>>;
  onRetry: (key: GoogleSectionKey) => void;
};

type GoogleDashboardProps = {
  data: GoogleUnpackedData;
  privacyMode: boolean;
  onPrivacyModeChange: (enabled: boolean) => void;
  mailBodies?: MailBodiesControl;
  sections?: SectionsControl;
};

type TabId = "overview" | "activity" | "chrome" | "gemini" | "mail" | "photos" | "play" | "games" | "drive" | "fit" | "more" | "youtube" | "coverage";
type Granularity = "day" | "week" | "month" | "year";

type NavItem = { id: TabId; label: string; icon: LucideIcon; accent: string };

const NAV_GROUPS: { heading?: string; items: NavItem[] }[] = [
  { items: [{ id: "overview", label: "Overview", icon: LayoutDashboard, accent: "#4285f4" }] },
  {
    heading: "Browsing and watching",
    items: [
      { id: "activity", label: "My Activity", icon: Activity, accent: "#4285f4" },
      { id: "chrome", label: "Chrome History", icon: Globe, accent: "#34a853" },
      { id: "youtube", label: "YouTube", icon: PlayCircle, accent: "#ea4335" },
    ],
  },
  { heading: "AI", items: [{ id: "gemini", label: "Gemini", icon: Sparkles, accent: "#a142f4" }] },
  {
    heading: "Mail and people",
    items: [
      { id: "mail", label: "Gmail", icon: Mail, accent: "#ea4335" },
      { id: "more", label: "More services", icon: Users, accent: "#4285f4" },
    ],
  },
  {
    heading: "Media and health",
    items: [
      { id: "photos", label: "Photos", icon: ImageIcon, accent: "#fbbc04" },
      { id: "fit", label: "Fit", icon: Footprints, accent: "#34a853" },
      { id: "play", label: "Play Store", icon: Smartphone, accent: "#34a853" },
      { id: "games", label: "Play Games", icon: Gamepad2, accent: "#24c1e0" },
    ],
  },
  { heading: "Files", items: [{ id: "drive", label: "Drive", icon: HardDrive, accent: "#fbbc04" }] },
  { items: [{ id: "coverage", label: "Coverage", icon: FolderTree, accent: "#9aa0a6" }] },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function navHasData(id: TabId, data: GoogleUnpackedData): boolean {
  switch (id) {
    case "activity":
      return Boolean(data.activity);
    case "chrome":
      return Boolean(data.chromeHistory?.parsedFiles);
    case "mail":
      return sectionPending(data, "mail") || Boolean(data.mail?.messages);
    case "gemini":
      return Boolean(data.gemini?.prompts);
    case "games":
      return Boolean(data.playGames?.parsedFiles);
    case "drive":
      return Boolean(data.drive);
    case "photos":
      return sectionPending(data, "photos") || Boolean(data.photos);
    case "play":
      return Boolean(data.playStore);
    case "fit":
      return sectionPending(data, "fit") || Boolean(data.fit?.parsedFiles);
    case "more":
      return Boolean(data.moreServices);
    case "youtube":
      return Boolean(data.youtube);
    default:
      return true;
  }
}

const numberFormatter = new Intl.NumberFormat("en");
const byteFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${byteFormatter.format(bytes / 1_000_000_000)} GB`;
  if (bytes >= 1_000_000) return `${byteFormatter.format(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${byteFormatter.format(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function yAxisWidth(maxValue: number): number {
  return Math.max(34, String(Math.round(maxValue)).length * 9 + 12);
}

function mask(value: string | undefined, privacyMode: boolean, fallback = "Hidden in privacy mode"): string {
  if (!value) return "Unknown";
  return privacyMode ? fallback : value;
}

function statusClass(status: GoogleCoverageStatus | "available" | "missing") {
  if (status === "parsed") return "border-[#34a853]/30 bg-[#34a853]/10 text-[#b8f3c9]";
  if (status === "available" || status === "indexed") return "border-[#4285f4]/30 bg-[#4285f4]/10 text-[#c8dcff]";
  if (status === "deferred") return "border-[#fbbc04]/30 bg-[#fbbc04]/10 text-[#ffe48a]";
  if (status === "missing" || status === "skipped") return "border-white/10 bg-white/5 text-white/55";
  return "border-[#ea4335]/30 bg-[#ea4335]/10 text-[#ffb7ae]";
}

function StatTile({ label, value, detail, icon: Icon, tone = "blue" }: { label: string; value: string; detail: string; icon: LucideIcon; tone?: "blue" | "green" | "yellow" | "red" }) {
  const accent = tone === "green" ? "text-[#34a853]" : tone === "yellow" ? "text-[#fbbc04]" : tone === "red" ? "text-[#ea4335]" : "text-[#4285f4]";
  return (
    <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/55">{label}</span>
        <Icon className={`size-4 ${accent}`} aria-hidden="true" />
      </div>
      <div className="mt-3 text-3xl font-black text-white">{value}</div>
      <p className="mt-1 text-sm text-white/60">{detail}</p>
    </div>
  );
}

function ColumnChart({ items, color = "#4285f4", height = "h-56", xInterval, tickGap, decimals = false }: { items: GoogleRankedItem[]; color?: string; height?: string; xInterval?: number; tickGap?: number; decimals?: boolean }) {
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={items} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
          <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={xInterval} minTickGap={tickGap} />
          <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(max) + (decimals ? 8 : 0)} allowDecimals={decimals} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.06)" }} contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
          <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const SAMSUNG_MODELS: Record<string, string> = {
  "SM-G950F": "Galaxy S8", "SM-G955F": "Galaxy S8+", "SM-G960F": "Galaxy S9", "SM-G965F": "Galaxy S9+",
  "SM-G970F": "Galaxy S10e", "SM-G973F": "Galaxy S10", "SM-G975F": "Galaxy S10+",
  "SM-G980F": "Galaxy S20", "SM-G985F": "Galaxy S20+", "SM-G986B": "Galaxy S20+ 5G", "SM-G988B": "Galaxy S20 Ultra",
  "SM-G991B": "Galaxy S21", "SM-G996B": "Galaxy S21+", "SM-G998B": "Galaxy S21 Ultra",
  "SM-S901B": "Galaxy S22", "SM-S906B": "Galaxy S22+", "SM-S908B": "Galaxy S22 Ultra",
  "SM-S911B": "Galaxy S23", "SM-S916B": "Galaxy S23+", "SM-S918B": "Galaxy S23 Ultra",
  "SM-N950F": "Galaxy Note8", "SM-N960F": "Galaxy Note9", "SM-N970F": "Galaxy Note10", "SM-N975F": "Galaxy Note10+",
  "SM-N980F": "Galaxy Note20", "SM-N986B": "Galaxy Note20 Ultra",
  "SM-A515F": "Galaxy A51", "SM-A525F": "Galaxy A52", "SM-A346B": "Galaxy A34 5G", "SM-A536B": "Galaxy A53 5G", "SM-A546B": "Galaxy A54 5G",
};

// Play Store records "manufacturer model-code"; turn known codes into marketing names and keep the code visible.
function deviceDisplayName(raw: string): string {
  if (/^google sdk_gphone/i.test(raw)) return "Android emulator";
  const [maker, ...rest] = raw.split(" ");
  const code = rest.join(" ");
  const name = maker.toLowerCase() === "samsung" ? SAMSUNG_MODELS[code.toUpperCase()] : undefined;
  return name ? `${name} (${code})` : raw;
}

// A list that is only a row or two over its limit is shown whole rather than hiding a "Show 1 more" button behind it.
const MIN_HIDDEN = 3;

function ExpandableList<T>({ items, initial = 10, noun = "items", children }: { items: T[]; initial?: number; noun?: string; children: (visible: T[]) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const hidden = items.length - initial >= MIN_HIDDEN ? items.length - initial : 0;
  return (
    <>
      {children(open || hidden <= 0 ? items : items.slice(0, initial))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white/65 transition hover:bg-white/5 hover:text-white"
        >
          {open ? "Show fewer" : `Show ${formatNumber(hidden)} more ${noun}`}
          <ChevronDown className={`size-4 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

function OriginGroup({ title, items, total, privacyMode, privateLabels = false }: { title: string; items: GoogleRankedItem[]; total: number; privacyMode: boolean; privateLabels?: boolean }) {
  if (!items.length) return null;
  if (items.length === 1) {
    const [item] = items;
    const label = privateLabels ? mask(item.label, privacyMode, "hidden") : item.label;
    return (
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">{title}</p>
        <p className="mt-1 text-sm text-white/80">
          <span className="font-semibold text-white">{label}</span>
          {item.count >= total ? ", for every item" : `, ${formatNumber(item.count)} of ${formatNumber(total)} items`}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">{title}</p>
      <div className="mt-2">
        <BarRows items={items} privacyMode={privacyMode} privateLabels={privateLabels} />
      </div>
    </div>
  );
}

function BarRows({ items, privacyMode, privateLabels = false, formatValue = formatNumber, initial }: { items: GoogleRankedItem[]; privacyMode: boolean; privateLabels?: boolean; formatValue?: (count: number) => string; initial?: number }) {
  const [open, setOpen] = useState(false);
  const max = Math.max(...items.map((item) => item.count), 1);
  const limit = initial ?? 10;
  const hidden = items.length - limit >= MIN_HIDDEN ? items.length - limit : 0;
  const shown = open || hidden <= 0 ? items : items.slice(0, limit);
  return (
    <div className="space-y-3">
      {shown.map((item) => {
        const width = Math.max(4, Math.round((item.count / max) * 100));
        return (
          <div key={item.label} className="grid grid-cols-[minmax(88px,150px)_minmax(0,1fr)_56px] items-center gap-3">
            <span className="truncate text-xs text-white/65" title={privateLabels && privacyMode ? undefined : item.label}>{privateLabels ? mask(item.label, privacyMode, "hidden") : item.label}</span>
            <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[#4285f4]" style={{ width: `${width}%` }} />
            </div>
            <span className="text-right text-xs text-white/55">{formatValue(item.count)}</span>
          </div>
        );
      })}
      {hidden > 0 ? (
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center justify-center gap-2 rounded-md py-1.5 text-xs font-semibold text-white/65 transition hover:bg-white/5 hover:text-white">
          {open ? "Show fewer" : `Show ${formatNumber(hidden)} more`}
          <ChevronDown className={`size-3.5 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ActivityRow({ entry, privacyMode }: { entry: GoogleActivityEntry; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[130px_minmax(0,1fr)_160px] md:items-center">
      <div>
        <span className="rounded-md border border-[#4285f4]/30 bg-[#4285f4]/10 px-2 py-1 text-xs font-semibold text-[#c8dcff]">{entry.service}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "Activity hidden")}</p>
        <p className="truncate text-xs text-white/55">
          {mask(entry.host, privacyMode, "host hidden")}
          {entry.hasLocation ? " / location metadata" : ""}
          {entry.detailCount ? ` / ${entry.detailCount} detail row${entry.detailCount === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.time)}</p>
    </div>
  );
}

function ChromeDeviceRow({ device, index, devices, privacyMode }: { device: GoogleChromeDevice; index: number; devices: GoogleChromeDevice[]; privacyMode: boolean }) {
  const starts = devices.flatMap((item) => (item.firstSeen ? [Date.parse(item.firstSeen)] : []));
  const ends = devices.flatMap((item) => (item.lastSeen ? [Date.parse(item.lastSeen)] : []));
  const rangeStart = Math.min(...starts);
  const span = Math.max(Math.max(...ends) - rangeStart, 1);
  const first = device.firstSeen ? Date.parse(device.firstSeen) : undefined;
  const last = device.lastSeen ? Date.parse(device.lastSeen) : undefined;
  const left = first === undefined ? 0 : ((first - rangeStart) / span) * 100;
  const width = first === undefined || last === undefined ? 0 : Math.max(((last - first) / span) * 100, 1.5);
  const color = STACK_COLORS[index % STACK_COLORS.length];
  return (
    <div className="border-b border-white/10 py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-white">
          {device.listed ? mask(deviceDisplayName(device.label), privacyMode, `Device ${index + 1}`) : device.label}
          {device.platform || device.chromeVersion ? <span className="ml-2 text-xs font-normal text-white/50">{[device.platform, device.chromeVersion].filter(Boolean).join(" / ")}</span> : null}
        </p>
        <p className="text-xs text-white/55">
          {formatNumber(device.visits)} visits ({device.share < 0.01 ? "<1%" : formatPercent(device.share)})
        </p>
      </div>
      <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div className="absolute inset-y-0 rounded-full" style={{ left: `${Math.min(left, 100 - width)}%`, width: `${width}%`, backgroundColor: color }} />
      </div>
      <p className="mt-2 text-xs text-white/55">
        {first === undefined ? "No dated visits" : `${formatShortDate(device.firstSeen)} to ${formatShortDate(device.lastSeen)}`}
      </p>
      {device.topHosts.length ? (
        <p className="mt-1 break-words text-xs text-white/70">
          Mostly {device.topHosts.map((host) => `${mask(host.label, privacyMode, "hidden")} (${formatNumber(host.count)})`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function ChromeHistoryRow({ entry, privacyMode }: { entry: GoogleChromeHistoryEntry; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_150px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "Page hidden")}</p>
        <p className="truncate text-xs text-white/55">{mask(entry.host, privacyMode, "domain hidden")}</p>
      </div>
      <p className="truncate text-xs text-white/55">{entry.deviceLabel ? mask(deviceDisplayName(entry.deviceLabel), privacyMode, "device hidden") : "Unknown device"}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.time)}</p>
    </div>
  );
}

function YouTubeWatchRow({ entry, privacyMode }: { entry: YouTubeWatchEntry; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "Video hidden")}</p>
        <p className="truncate text-xs text-white/55">
          {mask(entry.channelName, privacyMode, "channel hidden")}
          {entry.isAd ? " / ad" : ""}
          {entry.isRemoved ? " / removed" : ""}
        </p>
      </div>
      <p className="truncate text-xs text-white/55">{mask(entry.videoUrl, privacyMode, "url hidden")}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.time)}</p>
    </div>
  );
}

function YouTubeSearchRow({ entry, privacyMode }: { entry: YouTubeSearchEntry; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.query, privacyMode, "Search hidden")}</p>
        <p className="truncate text-xs text-white/55">YouTube search</p>
      </div>
      <p className="truncate text-xs text-white/55">{mask(entry.resultUrl, privacyMode, "url hidden")}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.time)}</p>
    </div>
  );
}

type RecapMetric = "events" | "services" | GoogleRecapSourceKey;

const HEAT_OPACITY = [0.28, 0.5, 0.75, 1];
const HEAT_CELL = 11;
const HEAT_GAP = 3;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDayLong(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { weekday: "long", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function dayValue(day: GoogleRecapDay, metric: RecapMetric): number {
  if (metric === "events") return day.total;
  if (metric === "services") return day.services;
  return day.counts[metric] ?? 0;
}

// Four brightness levels from quartile-like cut points over the active days, so a few huge days do not wash out the rest.
function heatLevels(values: number[]): number[] {
  const sorted = [...values].filter((value) => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return [1, 2, 3];
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  return [at(0.25), at(0.5), at(0.85)];
}

function heatLevel(value: number, cuts: number[]): number {
  if (value <= 0) return 0;
  if (value <= cuts[0]) return 1;
  if (value <= cuts[1]) return 2;
  if (value <= cuts[2]) return 3;
  return 4;
}

function RecapSection({ recap }: { recap: GoogleRecap }) {
  const lastYear = recap.years[recap.years.length - 1].year;
  const [year, setYear] = useState(lastYear);
  const [metric, setMetric] = useState<RecapMetric>("events");
  const [picked, setPicked] = useState<string | undefined>();

  const dayByDate = useMemo(() => new Map(recap.days.map((day) => [day.date, day])), [recap.days]);
  const metricColor = metric === "events" || metric === "services" ? "#4285f4" : recap.sources.find((source) => source.key === metric)?.color ?? "#4285f4";

  const yearDays = useMemo(() => recap.days.filter((day) => day.date.startsWith(year)), [recap.days, year]);
  // Shades are worked out within the chosen year: one service that only covers part of the export (Chrome history is a single year)
  // would otherwise push every day of its years to the brightest shade.
  const cuts = useMemo(() => heatLevels(yearDays.map((day) => dayValue(day, metric))), [yearDays, metric]);
  const bestOfYear = useMemo(() => yearDays.reduce<GoogleRecapDay | undefined>((best, day) => (!best || dayValue(day, metric) > dayValue(best, metric) ? day : best), undefined), [yearDays, metric]);
  const shown = picked && picked.startsWith(year) ? dayByDate.get(picked) ?? bestOfYear : bestOfYear;

  // Weeks run Sunday to Saturday; the first column is padded so January lines up under its weekday.
  const cells = useMemo(() => {
    const start = new Date(`${year}-01-01T00:00:00Z`);
    const end = new Date(`${year}-12-31T00:00:00Z`);
    const lead = start.getUTCDay();
    const out: { date?: string }[] = Array.from({ length: lead }, () => ({}));
    const monthStarts: { label: string; week: number }[] = [];
    for (let time = start.getTime(), index = lead; time <= end.getTime(); time += 86_400_000, index += 1) {
      const date = new Date(time).toISOString().slice(0, 10);
      if (date.endsWith("-01")) monthStarts.push({ label: MONTH_NAMES[Number(date.slice(5, 7)) - 1], week: Math.floor(index / 7) });
      out.push({ date });
    }
    return { cells: out, monthStarts, weeks: Math.ceil(out.length / 7) };
  }, [year]);

  const metricOptions: { id: RecapMetric; label: string }[] = [
    { id: "events", label: "Everything" },
    { id: "services", label: "Services used" },
    ...recap.sources.map((source) => ({ id: source.key as RecapMetric, label: source.key === "activity" ? "Activity" : source.label })),
  ];
  const metricNote =
    metric === "events"
      ? "Brightness is the number of items that day across every service, compared with the other days of the year."
      : metric === "services"
        ? "Brightness is how many different services had something that day, compared with the other days of the year."
        : `Brightness is ${recap.sources.find((source) => source.key === metric)?.unit ?? "items"} that day, compared with the other days of the year.`;
  const shownValue = shown ? dayValue(shown, metric) : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Busiest day" value={formatCalendarDay(recap.busiest.date)} detail={`${formatNumber(recap.busiest.total)} items across ${recap.busiest.services} ${recap.busiest.services === 1 ? "service" : "services"}`} icon={Flame} tone="red" />
        <StatTile label="Most services in a day" value={formatCalendarDay(recap.mostServices.date)} detail={`${recap.mostServices.services} of ${recap.sources.length} services in one day`} icon={Layers} tone="yellow" />
        <StatTile label="Longest streak" value={`${formatNumber(recap.longestStreak.days)} days`} detail={`${formatCalendarDay(recap.longestStreak.startDate)} to ${formatCalendarDay(recap.longestStreak.endDate)}, anything at all`} icon={Route} tone="green" />
        <StatTile label="Days with activity" value={formatNumber(recap.days.length)} detail={`of ${formatNumber(recap.spanDays)} days from ${formatCalendarDay(recap.firstDate)} to ${formatCalendarDay(recap.lastDate)}`} icon={CalendarDays} />
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Your days at a glance</h2>
            <p className="mt-1 text-sm text-white/55">{metricNote} Pick a day to see what made it up.</p>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Year">
            {recap.years.map((item) => (
              <button
                key={item.year}
                type="button"
                onClick={() => setYear(item.year)}
                aria-pressed={item.year === year}
                className={`h-8 rounded-md border px-2.5 text-xs font-semibold transition ${item.year === year ? "border-[#4285f4]/60 bg-[#4285f4]/20 text-white" : "border-white/10 text-white/60 hover:bg-white/5 hover:text-white"}`}
              >
                {item.year}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="What to colour by">
          {metricOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMetric(option.id)}
              aria-pressed={option.id === metric}
              className={`h-8 rounded-md border px-2.5 text-xs font-semibold transition ${option.id === metric ? "border-white/40 bg-white/10 text-white" : "border-white/10 text-white/60 hover:bg-white/5 hover:text-white"}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto pb-2">
          <div style={{ width: cells.weeks * (HEAT_CELL + HEAT_GAP) }}>
            <div className="relative h-4 text-[10px] text-white/45">
              {cells.monthStarts.map((month) => (
                <span key={month.label} className="absolute top-0" style={{ left: month.week * (HEAT_CELL + HEAT_GAP) }}>
                  {month.label}
                </span>
              ))}
            </div>
            <div className="grid" style={{ gridAutoFlow: "column", gridTemplateRows: `repeat(7, ${HEAT_CELL}px)`, gridAutoColumns: `${HEAT_CELL}px`, gap: HEAT_GAP }}>
              {cells.cells.map((cell, index) => {
                if (!cell.date) return <span key={`pad-${index}`} aria-hidden="true" />;
                const day = dayByDate.get(cell.date);
                const value = day ? dayValue(day, metric) : 0;
                const level = heatLevel(value, cuts);
                const label = `${formatDayLong(cell.date)}: ${value ? formatNumber(value) : "nothing"}`;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    title={label}
                    aria-label={label}
                    onClick={() => setPicked(cell.date)}
                    className={`rounded-[2px] outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${level === 0 ? "bg-white/[0.06]" : ""} ${shown?.date === cell.date ? "ring-2 ring-white" : ""}`}
                    style={level ? { backgroundColor: metricColor, opacity: HEAT_OPACITY[level - 1] } : undefined}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[11px] text-white/45">
          Less
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`size-3 rounded-[2px] ${level === 0 ? "bg-white/[0.06]" : ""}`} style={level ? { backgroundColor: metricColor, opacity: HEAT_OPACITY[level - 1] } : undefined} aria-hidden="true" />
          ))}
          More
        </div>

        {shown ? (
          <div className="mt-4 rounded-lg border border-white/10 bg-[#0d0f14] p-4">
            <p className="text-sm font-semibold text-white">{formatDayLong(shown.date)}</p>
            <p className="mt-0.5 text-xs text-white/55">
              {formatNumber(shown.total)} {shown.total === 1 ? "item" : "items"} across {shown.services} {shown.services === 1 ? "service" : "services"}
              {metric !== "events" && metric !== "services" && shownValue === 0 ? `, none from ${recap.sources.find((source) => source.key === metric)?.label ?? "this service"}` : ""}
            </p>
            <div className="mt-3 space-y-2">
              {recap.sources
                .filter((source) => shown.counts[source.key])
                .sort((a, b) => (shown.counts[b.key] ?? 0) - (shown.counts[a.key] ?? 0))
                .map((source) => (
                  <div key={source.key} className="grid grid-cols-[minmax(110px,190px)_minmax(0,1fr)_88px] items-center gap-3">
                    <span className="truncate text-xs text-white/70">{source.label}</span>
                    <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.round(((shown.counts[source.key] ?? 0) / shown.total) * 100))}%`, backgroundColor: source.color }} />
                    </div>
                    <span className="text-right text-xs text-white/55">{formatNumber(shown.counts[source.key] ?? 0)}</span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-white/55">No activity was recorded in {year}.</p>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <h2 className="text-lg font-bold text-white">Which services, and when</h2>
        <p className="mt-1 text-sm text-white/55">Each row is one service, month by month. Brighter months had more of it, scaled to that service&apos;s own busiest month, so a small service stays visible next to a huge one.</p>
        <div className="mt-4 space-y-4">
          {recap.sources.map((source) => {
            const counts = recap.monthlyBySource[source.key] ?? [];
            const max = Math.max(...counts, 1);
            return (
              <div key={source.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  <span className="font-semibold text-white">{source.label}</span>
                  <span className="text-white/55">
                    {formatNumber(source.total)} {source.unit}, {formatCalendarDay(source.firstDate)} to {formatCalendarDay(source.lastDate)}
                  </span>
                </div>
                <div className="mt-1.5 flex h-5 gap-px">
                  {counts.map((count, index) => (
                    <span
                      key={recap.months[index]}
                      title={`${recap.months[index]}: ${formatNumber(count)}`}
                      className={`min-w-0 flex-1 rounded-[1px] ${count ? "" : "bg-white/[0.05]"}`}
                      style={count ? { backgroundColor: source.color, opacity: 0.2 + 0.8 * Math.sqrt(count / max) } : undefined}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="relative h-4 text-[10px] text-white/45">
            {recap.months.map((label, index) =>
              label.endsWith("-01") && (index === 0 || (recap.months.length - index) / recap.months.length > 0.04) ? (
                <span key={label} className="absolute top-0" style={{ left: `${(index / recap.months.length) * 100}%` }}>
                  {label.slice(0, 4)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>

      <p className="text-xs leading-5 text-white/45">
        Each item is counted once. Chrome and YouTube rows inside My Activity are split out so they are not counted twice; Chrome&apos;s own history file is used for the year it covers, and My Activity&apos;s Chrome rows fill earlier days. Fit, Play Games, and Drive are not included because they are not events. Dates are the clock Google printed, so a day can be off at the edges.
      </p>
    </div>
  );
}

function OverviewTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const topProducts = data.products.slice(0, 8).map((product) => ({ label: product.product, count: product.uncompressedSize }));
  const recap = useMemo(() => buildGoogleRecap(data), [data]);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <StatTile label="ZIP parts" value={formatNumber(data.summary.archiveCount)} detail={`${formatBytes(data.summary.selectedSize)}, ${formatNumber(data.summary.productCount)} products, ${formatNumber(data.summary.entryCount)} files`} icon={Archive} />
        <StatTile label="My Activity" value={formatNumber(data.activity?.total ?? 0)} detail={`${formatNumber(data.activity?.parsedFiles ?? 0)} files parsed`} icon={Activity} tone="yellow" />
        <StatTile label="Chrome History" value={formatNumber(data.chromeHistory?.total ?? 0)} detail={`${formatNumber(data.chromeHistory?.uniqueHosts ?? 0)} domains`} icon={Database} tone="green" />
        <StatTile label="Photos" value={sectionPending(data, "photos") ? "..." : formatNumber(data.photos?.total ?? 0)} detail={sectionPending(data, "photos") ? "reading in the background" : `${formatNumber(data.photos?.albumCount ?? 0)} albums, metadata only`} icon={ImageIcon} tone="yellow" />
        <StatTile label="Gmail" value={sectionPending(data, "mail") ? "..." : formatNumber(data.mail?.messages ?? 0)} detail={sectionPending(data, "mail") ? "reading in the background" : `messages from ${formatNumber(data.mail?.uniqueSenders ?? 0)} senders, headers only`} icon={Mail} tone="red" />
        <StatTile label="Gemini" value={formatNumber(data.gemini?.prompts ?? 0)} detail={`prompts in ${formatNumber(data.gemini?.conversations ?? 0)} conversations`} icon={Sparkles} tone="blue" />
        <StatTile label="Fit" value={sectionPending(data, "fit") ? "..." : formatNumber(data.fit?.totalSteps ?? 0)} detail={sectionPending(data, "fit") ? "reading in the background" : `steps over ${formatNumber(data.fit?.activeDays ?? 0)} active days`} icon={Footprints} tone="green" />
        <StatTile label="YouTube" value={formatNumber((data.youtube?.watch.total ?? 0) + (data.youtube?.search.total ?? 0))} detail={`${formatNumber(data.youtube?.watch.distinctChannels ?? 0)} channels`} icon={PlayCircle} tone="red" />
        <StatTile label="Play Store" value={formatNumber(data.playStore?.installs.total ?? 0)} detail={`installs and ${formatNumber(data.playStore?.purchases.total ?? 0)} purchases`} icon={Smartphone} tone="green" />
        <StatTile label="Play Games" value={formatNumber(data.playGames?.games ?? 0)} detail={data.playGames?.playtime ? `games, ${formatMinutes(data.playGames.playtime.totalMinutes)} played` : "games with activity"} icon={Gamepad2} tone="blue" />
        <StatTile label="Contacts and more" value={formatNumber(data.moreServices?.contacts?.total ?? 0)} detail="contacts, plus calendar, tasks, and more" icon={Users} tone="blue" />
        <StatTile label="Drive" value={formatBytes(data.drive?.totalBytes ?? 0)} detail={`${formatNumber(data.drive?.files ?? 0)} files, sizes and names only`} icon={HardDrive} tone="yellow" />
      </div>

      {data.activity?.timestampWarning ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          My Activity HTML timestamps include timezone abbreviations without offsets. Charts use the exported wall-clock time consistently, but exact UTC conversion is not guaranteed.
        </div>
      ) : null}

      {recap ? <RecapSection recap={recap} /> : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Largest product families</h2>
            <Database className="size-4 text-[#4285f4]" aria-hidden="true" />
          </div>
          <div className="mt-4 space-y-3">
            {topProducts.map((product) => {
              const max = Math.max(...topProducts.map((item) => item.count), 1);
              const width = Math.max(4, Math.round((product.count / max) * 100));
              return (
                <div key={product.label}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-medium text-white">{mask(product.label, privacyMode, "Product hidden")}</span>
                    <span className="text-white/55">{formatBytes(product.count)}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-white/10">
                    <div className="h-2 rounded-full bg-gradient-to-r from-[#4285f4] via-[#34a853] to-[#fbbc04]" style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Next useful tabs</h2>
          <div className="mt-4 space-y-2">
            {data.services.slice(0, 7).map((service) => (
              <div key={service.key} className="rounded-lg border border-white/10 bg-[#0d0f14] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">{service.label}</span>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${statusClass(service.status)}`}>{service.status}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-white/55">{formatNumber(service.files)} files / {service.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [service, setService] = useState("all");
  const [query, setQuery] = useState("");
  const activity = data.activity;
  const chartData =
    granularity === "day"
      ? activity?.activityByDay.map((item) => ({ label: item.date.slice(5), count: item.count })) ?? []
      : granularity === "week"
        ? activity?.activityByWeek ?? []
        : granularity === "month"
          ? activity?.activityByMonth ?? []
          : activity?.activityByYear ?? [];
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (activity?.recentEntries ?? []).filter((entry) => {
      if (service !== "all" && entry.service !== service) return false;
      if (!q) return true;
      return [entry.service, entry.title, entry.host, entry.action].some((value) => value?.toLowerCase().includes(q));
    });
  }, [activity?.recentEntries, query, service]);

  if (!activity) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No My Activity files from the supported service set were found in this export.
      </div>
    );
  }

  const maxChartValue = Math.max(...chartData.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Activities" value={formatNumber(activity.total)} detail={`${formatNumber(activity.parsedFiles)} files parsed`} icon={Activity} />
        <StatTile label="Busiest day" value={activity.busiestDay ? formatNumber(activity.busiestDay.count) : "0"} detail={activity.busiestDay?.date ?? "No dated rows"} icon={CalendarDays} tone="green" />
        <StatTile label="Longest streak" value={activity.longestActiveStreak ? `${formatNumber(activity.longestActiveStreak.days)}d` : "0d"} detail={activity.longestActiveStreak ? `${activity.longestActiveStreak.startDate} to ${activity.longestActiveStreak.endDate}` : "No streak yet"} icon={TrendingUp} tone="yellow" />
        <StatTile label="Recent list" value={formatNumber(activity.recentEntries.length)} detail={activity.isEntryListCapped ? `Capped from ${formatNumber(activity.total)}` : "All parsed rows shown"} icon={Timer} tone="red" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Activity over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["day", "week", "month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#4285f4] text-white" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Area type="monotone" dataKey="count" stroke="#4285f4" fill="#4285f4" fillOpacity={0.22} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Service mix</h2>
          <div className="mt-4">
            <BarRows items={activity.byService} privacyMode={privacyMode} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={activity.activityByHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...activity.activityByHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#34a853" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Top hosts</h2>
          <div className="mt-4">
            <BarRows items={activity.topHosts} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Recent activity</h2>
            <p className="text-sm text-white/55">{activity.isEntryListCapped ? `Showing the newest ${formatNumber(activity.recentEntryLimit)} parsed rows.` : "Showing every parsed row."}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select value={service} onChange={(event) => setService(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-[#0d0f14] px-3 text-sm text-white">
              <option value="all">All services</option>
              {activity.services.map((item) => (
                <option key={item.service} value={item.service}>{item.service}</option>
              ))}
            </select>
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-72"
                placeholder="Search visible rows"
              />
            </label>
          </div>
        </div>
        <div>
          <ExpandableList items={filteredEntries.slice(0, 120)} noun="rows">{(visible) => visible.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} privacyMode={privacyMode} />
          ))}</ExpandableList>
          {!filteredEntries.length ? <p className="p-4 text-sm text-white/55">No visible rows match those filters.</p> : null}
        </div>
      </div>
    </div>
  );
}

function ChromeHistoryTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [query, setQuery] = useState("");
  const chrome = data.chromeHistory;
  const chartData =
    granularity === "day"
      ? chrome?.historyByDay.map((item) => ({ label: item.date.slice(5), count: item.count })) ?? []
      : granularity === "week"
        ? chrome?.historyByWeek ?? []
        : granularity === "month"
          ? chrome?.historyByMonth ?? []
          : chrome?.historyByYear ?? [];
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (chrome?.recentEntries ?? []).filter((entry) => {
      if (!q) return true;
      return [entry.title, entry.url, entry.host, entry.deviceLabel].some((value) => value?.toLowerCase().includes(q));
    });
  }, [chrome?.recentEntries, query]);

  if (!chrome) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No supported Chrome history file was found in this export.
      </div>
    );
  }

  const maxChartValue = Math.max(...chartData.map((item) => item.count), 1);
  const dateDetail =
    chrome.dateRange?.start && chrome.dateRange.end
      ? `${formatDate(chrome.dateRange.start)} to ${formatDate(chrome.dateRange.end)}`
      : "No dated rows";

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Visits" value={formatNumber(chrome.total)} detail={`${formatNumber(chrome.parsedFiles)} history file parsed`} icon={Database} />
        <StatTile label="Domains" value={formatNumber(chrome.uniqueHosts)} detail={`${formatNumber(chrome.invalidUrlRows)} invalid URLs skipped for domains`} icon={FolderTree} tone="green" />
        <StatTile label="Devices" value={formatNumber(chrome.uniqueClients)} detail="Anonymous Chrome install IDs" icon={Smartphone} tone="yellow" />
        <StatTile label="Recent list" value={formatNumber(chrome.recentEntries.length)} detail={chrome.isEntryListCapped ? `Capped from ${formatNumber(chrome.total)}` : "All parsed rows shown"} icon={Timer} tone="red" />
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-bold text-white">History range</h2>
          <p className="text-sm text-white/55">{dateDetail}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Visits over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["day", "week", "month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#4285f4] text-white" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Area type="monotone" dataKey="count" stroke="#34a853" fill="#34a853" fillOpacity={0.22} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Top domains</h2>
          <div className="mt-4">
            <BarRows items={chrome.topHosts} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chrome.historyByHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...chrome.historyByHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#4285f4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Day of week</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chrome.historyByWeekday} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...chrome.historyByWeekday.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#34a853" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {chrome.devices.length ? (
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Your devices</h2>
          <p className="mt-1 text-sm text-white/55">
            {chrome.devices.some((device) => device.listed)
              ? "Each Chrome install has an anonymous ID; names come from the device list in your export. An install that is no longer signed in has no name left, so it shows as an older install. Reinstalling Chrome or starting a new profile creates a new ID, so one computer can appear more than once."
              : "Chrome exports an anonymous ID for each install, not a device name, so they are numbered by how much they were used. Reinstalling Chrome or starting a new profile creates a new ID, so one computer can appear more than once. The dates and top sites are the easiest way to tell them apart."}
          </p>
          <div className="mt-4">
            {chrome.devices.map((device, index) => (
              <ChromeDeviceRow key={device.label} device={device} index={index} devices={chrome.devices} privacyMode={privacyMode} />
            ))}
          </div>
          {chrome.signedInWithoutHistory.length ? (
            <p className="mt-4 border-t border-white/10 pt-3 text-xs text-white/55">
              Also in the device list, with no Chrome history here (often Google Play services entries for phones already shown above):{" "}
              {[...new Set(chrome.signedInWithoutHistory.map((device) => deviceDisplayName(device.label)))]
                .map((name, index) => {
                  const count = chrome.signedInWithoutHistory.filter((device) => deviceDisplayName(device.label) === name).length;
                  return `${mask(name, privacyMode, `Device ${chrome.devices.length + index + 1}`)}${count > 1 ? ` x${count}` : ""}`;
                })
                .join(", ")}
              .
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Recent pages</h2>
            <p className="text-sm text-white/55">{chrome.isEntryListCapped ? `Showing the newest ${formatNumber(chrome.recentEntryLimit)} parsed rows.` : "Showing every parsed row."}</p>
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-80"
              placeholder="Search visible rows"
            />
          </label>
        </div>
        <div>
          <ExpandableList items={filteredEntries.slice(0, 120)} noun="rows">{(visible) => visible.map((entry) => (
            <ChromeHistoryRow key={entry.id} entry={entry} privacyMode={privacyMode} />
          ))}</ExpandableList>
          {!filteredEntries.length ? <p className="p-4 text-sm text-white/55">No visible rows match that search.</p> : null}
        </div>
      </div>
    </div>
  );
}

function PhotosRow({ entry, privacyMode }: { entry: GooglePhotosEntry; privacyMode: boolean }) {
  const coordinates = entry.hasLocation && entry.latitude !== undefined && entry.longitude !== undefined ? `${entry.latitude.toFixed(3)}, ${entry.longitude.toFixed(3)}` : undefined;
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "File hidden")}</p>
        <p className="truncate text-xs text-white/55">
          {entry.mediaType}
          {entry.favorited ? " / favorite" : ""}
          {entry.views ? ` / ${formatNumber(entry.views)} view${entry.views === 1 ? "" : "s"}` : ""}
          {entry.albumFolder ? ` / ${privacyMode ? "folder hidden" : entry.albumFolder}` : ""}
        </p>
      </div>
      <p className="truncate text-xs text-white/55">{coordinates ? mask(coordinates, privacyMode, "location hidden") : "No location"}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.takenAt)}</p>
    </div>
  );
}

function PhotosTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [granularity, setGranularity] = useState<"month" | "year">("year");
  const [mediaFilter, setMediaFilter] = useState("all");
  const [query, setQuery] = useState("");
  const photos = data.photos;
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (photos?.recentEntries ?? []).filter((entry) => {
      if (mediaFilter !== "all" && entry.mediaType !== mediaFilter) return false;
      if (!q) return true;
      return [entry.title, entry.albumFolder, entry.deviceFolder, entry.source].some((value) => value?.toLowerCase().includes(q));
    });
  }, [mediaFilter, photos?.recentEntries, query]);

  if (!photos) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No Google Photos metadata sidecars (<code>.supplemental-metadata.json</code>) were found in this export. Include the Google Photos ZIP parts to see this tab.
      </div>
    );
  }

  const chartData = granularity === "year" ? photos.byYear : photos.byMonth;
  const maxChartValue = Math.max(...chartData.map((item) => item.count), 1);
  const locationShare = photos.total ? photos.withLocation / photos.total : 0;
  const rangeDetail = photos.dateRange?.start && photos.dateRange.end ? `${formatDate(photos.dateRange.start)} to ${formatDate(photos.dateRange.end)}` : "No dated items";
  const deviceItems = photos.deviceTypes.map((item) => ({ ...item, label: item.label.replace(/_/g, " ").toLowerCase() }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Items" value={formatNumber(photos.total)} detail={`${formatNumber(photos.photos)} photos / ${formatNumber(photos.videos)} videos`} icon={ImageIcon} tone="yellow" />
        <StatTile label="With location" value={formatPercent(locationShare)} detail={`${formatNumber(photos.withLocation)} items carry coordinates`} icon={MapPin} tone="red" />
        <StatTile label="Albums" value={formatNumber(photos.albumCount)} detail={`${formatNumber(photos.yearFolderCount)} year folders`} icon={FolderTree} tone="green" />
        <StatTile label="Views" value={formatNumber(photos.totalViews)} detail={`${formatNumber(photos.favorited)} favorites / ${formatNumber(photos.archived)} archived`} icon={TrendingUp} />
      </div>

      <div className="rounded-lg border border-[#4285f4]/30 bg-[#4285f4]/10 p-4 text-sm leading-6 text-[#c8dcff]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        Built from metadata sidecars only. The photo and video files themselves stay zipped and are never read, so there are no previews. Dates use when each item was taken, not when it was uploaded.
      </div>

      {photos.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {formatNumber(photos.malformedFiles)} sidecar{photos.malformedFiles === 1 ? "" : "s"} could not be parsed. {photos.warnings[0]}
        </div>
      ) : null}

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-bold text-white">Library range</h2>
          <p className="text-sm text-white/55">{rangeDetail}</p>
        </div>
        {photos.busiestDay ? <p className="mt-2 text-sm text-white/55">Busiest day: {formatNumber(photos.busiestDay.count)} items on {photos.busiestDay.date}</p> : null}
      </div>

      <div className={`grid grid-cols-1 gap-5 ${photos.topAlbums.length > 1 ? "xl:grid-cols-[minmax(0,1fr)_360px]" : ""}`}>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Items taken over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["year", "month"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#fbbc04] text-[#0d0f14]" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#fbbc04" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {photos.topAlbums.length > 1 ? (
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <h2 className="text-lg font-bold text-white">Top albums</h2>
            <div className="mt-4">
              <BarRows items={photos.topAlbums} privacyMode={privacyMode} privateLabels />
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={photos.byHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...photos.byHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#fbbc04" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Day of week</h2>
          <div className="mt-4">
            <ColumnChart items={photos.byWeekday} color="#fbbc04" />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Uploaded by year</h2>
          <p className="mt-1 text-xs text-white/55">When items reached Google Photos, which can be years after they were taken.</p>
          <div className="mt-4">
            <ColumnChart items={photos.uploadsByYear} color="#fbbc04" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Where they came from</h2>
          <div className="mt-4 space-y-4">
            <OriginGroup title="Upload source" items={photos.sources} total={photos.total} privacyMode={privacyMode} />
            <OriginGroup title="Device type" items={deviceItems} total={photos.total} privacyMode={privacyMode} />
            <OriginGroup title="Phone folders" items={photos.deviceFolders} total={photos.total} privacyMode={privacyMode} privateLabels />
            {photos.topAlbums.length === 1 ? <OriginGroup title="Named album" items={photos.topAlbums} total={photos.total} privacyMode={privacyMode} privateLabels /> : null}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">File types</h2>
          <div className="mt-4">
            <BarRows items={photos.extensions} privacyMode={privacyMode} />
          </div>
          {photos.sharedAlbumComments ? <p className="mt-4 text-xs text-white/55">{formatNumber(photos.sharedAlbumComments)} shared-album comments are in the export (text not shown).</p> : null}
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Recent items</h2>
            <p className="text-sm text-white/55">{photos.isEntryListCapped ? `Showing the ${formatNumber(photos.recentEntryLimit)} most recently taken items.` : "Showing every parsed item."}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-[#0d0f14] px-3 text-sm text-white">
              <option value="all">Photos and videos</option>
              <option value="photo">Photos</option>
              <option value="video">Videos</option>
              <option value="other">Other</option>
            </select>
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-72"
                placeholder="Search visible rows"
              />
            </label>
          </div>
        </div>
        <div>
          <ExpandableList items={filteredEntries.slice(0, 120)} noun="items">{(visible) => visible.map((entry) => (
            <PhotosRow key={entry.id} entry={entry} privacyMode={privacyMode} />
          ))}</ExpandableList>
          {!filteredEntries.length ? <p className="p-4 text-sm text-white/55">No visible rows match those filters.</p> : null}
        </div>
      </div>
    </div>
  );
}

function formatKm(value: number): string {
  return `${value.toLocaleString("en", { maximumFractionDigits: 1 })} km`;
}

function FitDayRow({ day, privacyMode, goal }: { day: GoogleFitDay; privacyMode: boolean; goal: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[150px_minmax(0,1fr)_110px_110px_110px] md:items-center">
      <p className="text-sm font-semibold text-white">{mask(day.date, privacyMode, "Date hidden")}</p>
      <p className="text-sm text-white md:text-left">
        {formatNumber(day.steps)} steps
        {day.steps >= goal ? <span className="ml-2 rounded-md border border-[#34a853]/30 bg-[#34a853]/10 px-1.5 py-0.5 text-xs font-semibold text-[#b8f3c9]">goal</span> : null}
      </p>
      <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1 md:contents">
        <p className="text-xs text-white/55 md:text-right">{formatKm(day.distanceM / 1000)}</p>
        <p className="text-xs text-white/55 md:text-right">{formatNumber(Math.round(day.moveMinutes))} move min</p>
        <p className="text-xs text-white/55 md:text-right">{formatNumber(Math.round(day.heartPoints))} heart pts</p>
      </div>
    </div>
  );
}

function FitTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [granularity, setGranularity] = useState<"month" | "year">("month");
  const fit = data.fit;

  if (!fit?.parsedFiles) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        {fit?.warnings.length
          ? `The Google Fit files in this export could not be read. ${fit.warnings[0]}`
          : "No Google Fit daily activity metrics were found in this export. Include the Fit folder (Daily activity metrics) from your Takeout to see this tab."}
      </div>
    );
  }

  const chartData = granularity === "year" ? fit.byYear : fit.byMonth;
  const maxChartValue = Math.max(...chartData.map((item) => item.steps), 1);
  const rangeDetail = fit.dateRange ? `${mask(fit.dateRange.start, privacyMode, "hidden")} to ${mask(fit.dateRange.end, privacyMode, "hidden")}` : "No active days";
  const goalShare = fit.totalDays ? fit.goalDays / fit.totalDays : 0;
  const maxMinutes = Math.max(...fit.byYear.map((item) => item.moveMinutes), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Steps" value={formatNumber(fit.totalSteps)} detail={`${formatNumber(fit.averageStepsPerActiveDay)} per day with steps`} icon={Footprints} tone="green" />
        <StatTile label="Distance" value={formatKm(fit.totalDistanceKm)} detail={`${formatNumber(fit.activeDays)} active days of ${formatNumber(fit.totalDays)} recorded`} icon={Route} />
        <StatTile label="Move minutes" value={formatNumber(Math.round(fit.totalMoveMinutes))} detail={`${formatNumber(Math.round(fit.totalHeartPoints))} heart points`} icon={HeartPulse} tone="red" />
        <StatTile label={`${formatNumber(fit.stepGoal)}+ step days`} value={formatNumber(fit.goalDays)} detail={`${formatPercent(goalShare)} of recorded days / ${formatNumber(fit.tenKDays)} reached 10,000`} icon={TrendingUp} tone="yellow" />
      </div>

      <div className="rounded-lg border border-[#34a853]/30 bg-[#34a853]/10 p-4 text-sm leading-6 text-[#b8f3c9]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        Built from the Daily activity metrics files only. The {formatNumber(fit.rawDataFiles)} raw data-point file{fit.rawDataFiles === 1 ? "" : "s"} in the Fit folder hold the same steps again, so they stay unread to avoid double counting.
        {fit.dailySource === "intervals" ? " No daily summary file was found, so days are summed from the 15-minute files." : ""}
        {privacyMode ? " Privacy mode hides exact dates; totals and averages stay visible." : ""}
      </div>

      {fit.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {formatNumber(fit.malformedFiles)} Fit file{fit.malformedFiles === 1 ? "" : "s"} could not be parsed. {fit.warnings[0]}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Best day"
          value={fit.bestDay ? formatNumber(fit.bestDay.steps) : "0"}
          detail={fit.bestDay ? `${mask(fit.bestDay.date, privacyMode, "Date hidden")} / ${formatKm(fit.bestDay.distanceM / 1000)}` : "No step data"}
          icon={Flame}
          tone="red"
        />
        <StatTile
          label={`${formatNumber(fit.stepGoal)}-step streak`}
          value={fit.goalStreak ? `${formatNumber(fit.goalStreak.days)}d` : "0d"}
          detail={fit.goalStreak ? `${mask(fit.goalStreak.startDate, privacyMode, "hidden")} to ${mask(fit.goalStreak.endDate, privacyMode, "hidden")}` : "No goal streak yet"}
          icon={TrendingUp}
          tone="green"
        />
        <StatTile
          label="Last tracked"
          value={fit.lastTrackedDate ? mask(fit.lastTrackedDate, privacyMode, "Hidden") : "Unknown"}
          detail={fit.dateRange ? `Recording spans ${rangeDetail}` : "No active days"}
          icon={CalendarDays}
          tone="yellow"
        />
        <StatTile
          label="Gaps"
          value={formatNumber(fit.untrackedDays)}
          detail={fit.longestGap ? `Days without data in the range. Longest gap ${formatNumber(fit.longestGap.days)} days` : "No missing days inside the recorded range"}
          icon={Timer}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Steps over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#34a853] text-[#0d0f14]" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="steps" name="Steps" fill="#34a853" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">By year</h2>
          <div className="mt-4 space-y-4">
            {fit.byYear.map((year) => (
              <div key={year.label}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-white">{year.label}</span>
                  <span className="text-xs text-white/55">{formatNumber(year.steps)} steps / {formatKm(year.distanceKm)}</span>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#34a853]" style={{ width: `${Math.max(4, Math.round((year.moveMinutes / maxMinutes) * 100))}%` }} />
                </div>
                <p className="mt-1 text-xs text-white/55">{formatNumber(Math.round(year.moveMinutes))} move minutes over {formatNumber(year.activeDays)} active days</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Average steps by weekday</h2>
          <p className="mt-1 text-xs text-white/55">Average over days that recorded steps.</p>
          <div className="mt-4">
            <ColumnChart items={fit.byWeekday} color="#34a853" />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Steps by time of day</h2>
          <p className="mt-1 text-xs text-white/55">Summed from the 15-minute files, in the local time they were recorded.</p>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fit.byHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...fit.byHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" name="Steps" fill="#34a853" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Biggest days</h2>
          <p className="text-sm text-white/55">Your ten highest step counts.</p>
        </div>
        <div>
          {fit.topDays.map((day) => (
            <FitDayRow key={day.date} day={day} privacyMode={privacyMode} goal={fit.stepGoal} />
          ))}
        </div>
      </div>
    </div>
  );
}

function formatShortDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function fillMonths(items: GoogleRankedItem[], carry = false): GoogleRankedItem[] {
  if (items.length < 2) return items;
  const counts = new Map(items.map((item) => [item.label, item.count]));
  const [startYear, startMonth] = items[0].label.split("-").map(Number);
  const [endYear, endMonth] = items[items.length - 1].label.split("-").map(Number);
  const filled: GoogleRankedItem[] = [];
  let year = startYear;
  let month = startMonth;
  let previous = 0;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const label = `${year}-${String(month).padStart(2, "0")}`;
    const count = counts.get(label) ?? (carry ? previous : 0);
    previous = count;
    filled.push({ label, count });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return filled;
}

function GeminiTextBlock({ who, text, privacyMode, accent }: { who: string; text: string; privacyMode: boolean; accent: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: accent }}>
        {who}
      </p>
      <div className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-[#0d0f14] p-3 text-sm leading-6 text-white/80">
        {privacyMode ? "Hidden in privacy mode" : text}
      </div>
    </div>
  );
}

function GeminiConversationRow({ conversation, privacyMode }: { conversation: GoogleGeminiConversation; privacyMode: boolean }) {
  const [open, setOpen] = useState(false);
  const firstPrompt = conversation.exchanges.find((exchange) => exchange.prompt)?.prompt.split("\n").find((line) => line.trim()) ?? "Attachment only";
  const title = firstPrompt.length > 110 ? `${firstPrompt.slice(0, 110)}...` : firstPrompt;
  const count = conversation.exchanges.length;
  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-white/5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{mask(title, privacyMode, "Conversation hidden")}</p>
          <p className="mt-1 text-xs text-white/55">
            {count} {count === 1 ? "prompt" : "prompts"} / {formatShortDate(conversation.firstTime)}
            {conversation.lastTime && conversation.lastTime.slice(0, 10) !== conversation.firstTime?.slice(0, 10) ? ` to ${formatShortDate(conversation.lastTime)}` : ""}
            {conversation.images ? ` / ${conversation.images} ${conversation.images === 1 ? "image" : "images"} made` : ""}
            {conversation.attachmentCount ? ` / ${conversation.attachmentCount} ${conversation.attachmentCount === 1 ? "file" : "files"} attached` : ""}
          </p>
        </div>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-white/55 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="space-y-5 border-t border-white/10 bg-black/10 px-4 py-4">
          {conversation.exchanges.map((exchange) => (
            <div key={exchange.id} className="space-y-3">
              <p className="text-xs text-white/45">{formatDate(exchange.time)}</p>
              <GeminiTextBlock who="You" text={exchange.prompt || "(attachment only)"} privacyMode={privacyMode} accent="#8ab4f8" />
              {exchange.attachments.some(Boolean) ? (
                <p className="break-words text-xs text-white/55">Attached: {mask(exchange.attachments.filter(Boolean).join(", "), privacyMode, "file names hidden")}</p>
              ) : exchange.attachments.length ? (
                <p className="text-xs text-white/55">{exchange.attachments.length} {exchange.attachments.length === 1 ? "file" : "files"} attached</p>
              ) : null}
              {exchange.images ? <p className="text-xs text-white/55">{exchange.images} generated {exchange.images === 1 ? "image" : "images"} (not stored in the activity file)</p> : null}
              {exchange.response ? (
                <GeminiTextBlock who="Gemini" text={exchange.response} privacyMode={privacyMode} accent="#c58af9" />
              ) : (
                <p className="text-xs text-white/45">No reply text was saved for this prompt.</p>
              )}
              {exchange.truncated ? <p className="text-xs text-white/45">Very long text is shortened here.</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GeminiTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const gemini = data.gemini;
  if (!gemini?.parsedFiles || !gemini.prompts) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        {gemini?.warnings.length
          ? `The Gemini activity file could not be read. ${gemini.warnings[0]}`
          : "No Gemini Apps activity was found in this export. Include My Activity (HTML format) with Gemini Apps selected to see this tab."}
      </div>
    );
  }

  const rangeDetail = gemini.dateRange?.start && gemini.dateRange.end ? `${formatShortDate(gemini.dateRange.start)} to ${formatShortDate(gemini.dateRange.end)}` : "No dated prompts";
  const monthItems = fillMonths(gemini.byMonth);
  const repliedShare = gemini.prompts ? gemini.withResponse / gemini.prompts : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Prompts" value={formatNumber(gemini.prompts)} detail={rangeDetail} icon={Sparkles} tone="blue" />
        <StatTile label="Conversations" value={formatNumber(gemini.conversations)} detail={`Longest has ${formatNumber(gemini.longestConversationPrompts)} prompts`} icon={Inbox} tone="green" />
        <StatTile label="Images made" value={formatNumber(gemini.images)} detail="Generated in your chats" icon={ImageIcon} tone="yellow" />
        <StatTile label="Files attached" value={formatNumber(gemini.attachedFiles)} detail={gemini.folderFiles.count ? `${formatNumber(gemini.folderFiles.count)} files, ${formatBytes(gemini.folderFiles.bytes)}, saved in the export` : "Sent with your prompts"} icon={Archive} tone="red" />
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <p className="text-sm leading-6 text-white/65">
          Built from your Gemini Apps activity file ({rangeDetail}). Prompts and replies are shown only when you open a conversation, and privacy mode hides them. Times are your account&apos;s local clock as Google printed them. Attached and generated files are counted but not opened.
          {gemini.busiestDay ? ` Busiest day: ${formatNumber(gemini.busiestDay.count)} prompts on ${gemini.busiestDay.date}.` : ""}
        </p>
        {gemini.otherEntries ? <p className="mt-2 text-xs text-white/50">{formatNumber(gemini.otherEntries)} other Gemini activity entries (not prompts) are counted in My Activity, not here.</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Prompts by month</h2>
          <div className="mt-4">
            <ColumnChart items={monthItems} color="#a142f4" tickGap={28} />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4">
            <ColumnChart items={gemini.byHour} color="#a142f4" xInterval={3} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">How long your prompts are</h2>
          <p className="mt-1 text-sm text-white/55">
            Typical prompt: {formatNumber(gemini.medianPromptChars)} characters. Longest: {formatNumber(gemini.longestPromptChars)}. {formatPercent(repliedShare)} have a saved reply.
          </p>
          <div className="mt-4">
            <ColumnChart items={gemini.promptLengths} color="#a142f4" />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">What you attach</h2>
          <div className="mt-4">
            {gemini.attachmentTypes.length ? <BarRows items={gemini.attachmentTypes} privacyMode={privacyMode} /> : <p className="text-sm text-white/55">No attached file names were recorded.</p>}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Conversations</h2>
          <p className="text-sm text-white/55">{gemini.isConversationListCapped ? `Showing the newest ${formatNumber(gemini.conversationLimit)}. Open one to read it.` : "Newest first. Open one to read it."}</p>
        </div>
        <ExpandableList items={gemini.conversationList} initial={8} noun="conversations">
          {(visible) => visible.map((conversation) => <GeminiConversationRow key={conversation.id} conversation={conversation} privacyMode={privacyMode} />)}
        </ExpandableList>
      </div>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours >= 100 ? formatNumber(Math.round(hours)) : hours.toFixed(1)} h`;
}

function minutesToHours(items: GoogleRankedItem[]): GoogleRankedItem[] {
  return items.map((item) => ({ label: item.label, count: Math.round(item.count / 6) / 10 }));
}

function PlayGameRow({ game, privacyMode }: { game: GooglePlayGame; privacyMode: boolean }) {
  const [open, setOpen] = useState(false);
  const canOpen = game.achievements.length > 0 || game.scores.length > 0;
  const facts = [
    game.firstPlayed ? `${formatShortDate(game.firstPlayed)} to ${formatShortDate(game.lastPlayed)}` : undefined,
    game.achievementTotal ? `${game.unlocked} of ${game.achievementTotal} achievements` : game.unlocked ? `${game.unlocked} achievements` : undefined,
    game.xp ? `${formatNumber(game.xp)} XP` : undefined,
    game.playtimeMinutes ? `${formatMinutes(game.playtimeMinutes)} played in ${formatNumber(game.sessions)} sessions` : undefined,
    game.scoreCount ? `${game.scoreCount} ${game.scoreCount === 1 ? "score" : "scores"}` : undefined,
    game.cloudSaves ? `${game.cloudSaves} cloud ${game.cloudSaves === 1 ? "save" : "saves"}` : undefined,
  ].filter(Boolean);
  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button
        type="button"
        onClick={() => canOpen && setOpen((value) => !value)}
        aria-expanded={canOpen ? open : undefined}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition ${canOpen ? "hover:bg-white/5" : "cursor-default"}`}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{mask(game.title, privacyMode, "Game hidden")}</p>
          <p className="mt-1 text-xs text-white/55">{facts.length ? facts.join(" / ") : "No details in this export"}</p>
        </div>
        {canOpen ? <ChevronDown className={`mt-1 size-4 shrink-0 text-white/55 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="grid grid-cols-1 gap-5 border-t border-white/10 bg-black/10 px-4 py-4 md:grid-cols-2">
          {game.achievements.length ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Achievements</p>
              <div className="mt-2 space-y-1">
                {game.achievements.map((achievement, index) => (
                  <div key={`${achievement.name}-${index}`} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className={`min-w-0 truncate ${achievement.state.toLowerCase() === "unlocked" ? "text-white" : "text-white/45"}`}>{mask(achievement.name, privacyMode, "Achievement hidden")}</span>
                    <span className="shrink-0 text-xs text-white/50">
                      {achievement.state.toLowerCase() === "unlocked" ? `${achievement.xp ? `${formatNumber(achievement.xp)} XP / ` : ""}${formatShortDate(achievement.date)}` : achievement.state}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {game.scores.length ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Scores</p>
              <div className="mt-2 space-y-1">
                {game.scores.map((score, index) => (
                  <div key={`${score.leaderboard}-${index}`} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-white/80">{mask(score.leaderboard || "Leaderboard", privacyMode, "Leaderboard hidden")}</span>
                    <span className="shrink-0 text-xs text-white/50">
                      {formatNumber(Number(score.score) || 0)} / {formatShortDate(score.date)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fillYears(items: GoogleRankedItem[]): GoogleRankedItem[] {
  if (items.length < 2) return items;
  const counts = new Map(items.map((item) => [item.label, item.count]));
  const first = Number(items[0].label);
  const last = Number(items[items.length - 1].label);
  const filled: GoogleRankedItem[] = [];
  for (let year = first; year <= last; year += 1) filled.push({ label: String(year), count: counts.get(String(year)) ?? 0 });
  return filled;
}

// Drive dates are plain YYYY-MM-DD with no time zone, so format them as UTC to keep the day from shifting.
function formatCalendarDay(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function formatShare(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  const share = part / total;
  return share < 0.01 ? "<1%" : formatPercent(share);
}

function DriveTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const drive = data.drive;
  if (!drive) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No Google Drive files were found in this export. Include the Drive folder in your Takeout to see this tab.
      </div>
    );
  }

  const biggest = drive.largestFiles[0];
  const topThree = drive.largestFiles.slice(0, 3).reduce((sum, file) => sum + file.bytes, 0);
  const maxTypeBytes = Math.max(...drive.byType.map((item) => item.bytes), 1);
  const years = fillYears(drive.byYear);
  const maxFolderBytes = Math.max(...drive.byFolder.map((item) => item.bytes), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Files" value={formatNumber(drive.files)} detail={`in ${formatNumber(drive.folders)} ${drive.folders === 1 ? "folder" : "folders"}`} icon={FolderTree} tone="yellow" />
        <StatTile label="Total size" value={formatBytes(drive.totalBytes)} detail={drive.dateRange ? `files last changed ${formatCalendarDay(drive.dateRange.start)} to ${formatCalendarDay(drive.dateRange.end)}` : "no dates recorded"} icon={HardDrive} tone="green" />
        <StatTile label="Inside archives" value={formatBytes(drive.archives.bytes)} detail={`${formatNumber(drive.archives.files)} ${drive.archives.files === 1 ? "archive" : "archives"}, ${formatShare(drive.archives.bytes, drive.totalBytes)} of the total`} icon={Archive} tone="red" />
        <StatTile label="Largest file" value={biggest ? formatBytes(biggest.bytes) : "None"} detail={biggest ? `${mask(biggest.name, privacyMode, "Name hidden")}, ${formatShare(biggest.bytes, drive.totalBytes)} of the total` : "No files"} icon={FileWarning} tone="blue" />
      </div>

      <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        This tab is built from the file list inside your ZIP: names, sizes, and the date each file last changed. No Drive file is opened, and archives like .zip and .7z stay closed.
        {drive.largestFiles.length >= 3 ? ` The three biggest files take up ${formatShare(topThree, drive.totalBytes)} of everything.` : ""}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Space by kind</h2>
          <p className="mt-1 text-xs text-white/55">Grouped from file extensions, ranked by size.</p>
          <div className="mt-4">
            <BarRows items={drive.byCategory.map((category) => ({ label: `${category.label} (${formatNumber(category.files)})`, count: category.bytes }))} privacyMode={privacyMode} formatValue={formatBytes} />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Files by year last changed</h2>
          <p className="mt-1 text-xs text-white/55">When each file was last modified, not when it was uploaded.</p>
          <div className="mt-4">
            <ColumnChart items={years} color="#fbbc04" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Biggest folders</h2>
          <p className="mt-1 text-xs text-white/55">Each file counts toward its top-level folder. The first number is how many files.</p>
          <div className="mt-4 space-y-3">
            {drive.byFolder.map((folder) => (
              <div key={folder.path} className="grid grid-cols-[minmax(88px,150px)_minmax(0,1fr)_120px] items-center gap-3">
                <span className="truncate text-xs text-white/65" title={privacyMode || !folder.path ? undefined : folder.path}>{folder.path ? mask(folder.path, privacyMode, "Folder hidden") : "Top level"}</span>
                <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#4285f4]" style={{ width: `${Math.max(4, Math.round((folder.bytes / maxFolderBytes) * 100))}%` }} />
                </div>
                <span className="text-right text-xs text-white/55">
                  {formatNumber(folder.files)} / {formatBytes(folder.bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">File types</h2>
          <p className="mt-1 text-xs text-white/55">Ranked by size. The first number is how many files.</p>
          <div className="mt-4 space-y-3">
            {drive.byType.map((item) => (
              <div key={item.extension} className="grid grid-cols-[64px_minmax(0,1fr)_120px] items-center gap-3">
                <span className="truncate text-xs font-semibold text-white">{item.extension}</span>
                <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#fbbc04]" style={{ width: `${Math.max(4, Math.round((item.bytes / maxTypeBytes) * 100))}%` }} />
                </div>
                <span className="text-right text-xs text-white/55">
                  {formatNumber(item.files)} / {formatBytes(item.bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Largest files</h2>
          <p className="text-sm text-white/55">
            {drive.isLargestCapped ? `The ${formatNumber(drive.largestLimit)} biggest of ${formatNumber(drive.files)} files.` : `All ${formatNumber(drive.files)} ${drive.files === 1 ? "file" : "files"}, biggest first.`}
          </p>
        </div>
        <ExpandableList items={drive.largestFiles} initial={10} noun="files">
          {(visible) =>
            visible.map((file) => (
              <div key={file.path} className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_90px_70px_120px] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white" title={privacyMode ? undefined : file.name}>{mask(file.name, privacyMode, "Name hidden")}</p>
                  <p className="truncate text-xs text-white/55">{file.folder ? mask(file.folder, privacyMode, "Folder hidden") : "Top level"}</p>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
                  <p className="text-sm text-white md:text-right">{formatBytes(file.bytes)}</p>
                  <p className="text-xs text-white/55 md:text-right">{formatShare(file.bytes, drive.totalBytes)}</p>
                  <p className="text-xs text-white/55 md:text-right">{file.modified ? formatCalendarDay(file.modified) : "No date"}</p>
                </div>
              </div>
            ))
          }
        </ExpandableList>
      </div>
    </div>
  );
}

function PlayGamesTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [query, setQuery] = useState("");
  const games = data.playGames;
  const filteredGames = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (games?.gameList ?? []).filter((game) => !q || game.title.toLowerCase().includes(q));
  }, [games?.gameList, query]);

  if (!games?.parsedFiles) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        {games?.warnings.length
          ? `The Play Games files in this export could not be read. ${games.warnings[0]}`
          : "No Google Play Games data was found in this export. Include the Google Play Games Services folder in your Takeout to see this tab."}
      </div>
    );
  }

  const { profile, playtime, streaks } = games;
  const xpItems = fillMonths(games.xpTimeline, true);
  const maxXp = Math.max(...xpItems.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Games" value={formatNumber(games.games)} detail={`${formatNumber(games.gamesWithAchievements)} have achievements`} icon={Gamepad2} tone="green" />
        <StatTile label="Playtime" value={playtime ? formatMinutes(playtime.totalMinutes) : "None"} detail={playtime ? `${formatNumber(playtime.sessions)} sessions on ${formatNumber(playtime.activeDays)} days` : "No playtime file in this export"} icon={Timer} tone="blue" />
        <StatTile label="Achievements" value={formatNumber(games.unlockedAchievements)} detail={`unlocked, of ${formatNumber(games.achievementRows)} listed`} icon={Flame} tone="yellow" />
        <StatTile label="Level" value={profile?.level !== undefined ? formatNumber(profile.level) : "None"} detail={profile?.xp !== undefined ? `${formatNumber(profile.xp)} XP${profile.categoryMostXp ? `, most in ${profile.categoryMostXp}` : ""}` : "No profile file in this export"} icon={TrendingUp} tone="red" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {streaks ? (
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <h2 className="text-lg font-bold text-white">Play streaks</h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="text-3xl font-black text-white">{formatNumber(streaks.longest)}</p>
                <p className="text-sm text-white/60">days, longest streak</p>
              </div>
              <div>
                <p className="text-3xl font-black text-white">{formatNumber(streaks.current)}</p>
                <p className="text-sm text-white/60">{streaks.current === 1 ? "day, current streak" : "days, current streak"}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-white/55">
              The streak log lists {formatNumber(streaks.days)} days{streaks.firstDate ? ` from ${formatShortDate(streaks.firstDate)} to ${formatShortDate(streaks.lastDate)}` : ""}.
            </p>
            <div className="mt-3">
              <OriginGroup title="Most played game on those days" items={streaks.mostPlayed} total={streaks.days} privacyMode={privacyMode} privateLabels />
            </div>
          </div>
        ) : null}
        {profile ? (
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <h2 className="text-lg font-bold text-white">Your player profile</h2>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {profile.gamerId ? (
                <>
                  <dt className="text-white/55">Gamer ID</dt>
                  <dd className="truncate text-white">{mask(profile.gamerId, privacyMode, "Hidden in privacy mode")}</dd>
                </>
              ) : null}
              {profile.visibility ? (
                <>
                  <dt className="text-white/55">Profile</dt>
                  <dd className="text-white">{profile.visibility}</dd>
                </>
              ) : null}
              {profile.lastGame ? (
                <>
                  <dt className="text-white/55">Last game played</dt>
                  <dd className="truncate text-white">
                    {mask(profile.lastGame, privacyMode, "Game hidden")}
                    {profile.lastGameDate ? `, ${formatShortDate(profile.lastGameDate)}` : ""}
                  </dd>
                </>
              ) : null}
              {profile.lastLevelledUp ? (
                <>
                  <dt className="text-white/55">Last levelled up</dt>
                  <dd className="text-white">{formatShortDate(profile.lastLevelledUp)}</dd>
                </>
              ) : null}
              <dt className="text-white/55">Community</dt>
              <dd className="text-white">
                {formatNumber(profile.followers)} followers, {formatNumber(profile.following)} following
              </dd>
            </dl>
          </div>
        ) : null}
      </div>

      {playtime ? (
        <>
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <p className="text-sm leading-6 text-white/65">
              Playtime covers {formatShortDate(playtime.dateRange?.start)} to {formatShortDate(playtime.dateRange?.end)}, the part of your history Google keeps per day, across {formatNumber(playtime.packages)} games.
              {playtime.longestDay ? ` Longest day: ${formatMinutes(playtime.longestDay.minutes)} on ${playtime.longestDay.date}.` : ""}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
              <h2 className="text-lg font-bold text-white">Hours played by month</h2>
              <div className="mt-4">
                <ColumnChart items={minutesToHours(fillMonths(playtime.byMonth))} color="#34a853" tickGap={28} decimals />
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
              <h2 className="text-lg font-bold text-white">Hours by day of week</h2>
              <div className="mt-4">
                <ColumnChart items={minutesToHours(playtime.byWeekday)} color="#34a853" decimals />
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <h2 className="text-lg font-bold text-white">Time by game</h2>
            <div className="mt-4">
              <BarRows items={playtime.byGame} privacyMode={privacyMode} privateLabels formatValue={formatMinutes} />
            </div>
          </div>
        </>
      ) : null}

      {xpItems.length > 1 ? (
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Experience points over time</h2>
          <p className="mt-1 text-sm text-white/55">Your account-wide XP total. Each month shows the highest total reached by then.</p>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={xpItems} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={40} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxXp)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Area type="monotone" dataKey="count" name="XP" stroke="#34a853" fill="#34a853" fillOpacity={0.22} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Most achievements</h2>
          <div className="mt-4">
            <BarRows items={games.topByAchievements} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Most XP</h2>
          <div className="mt-4">
            <BarRows items={games.topByXp} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Your games</h2>
            <p className="text-sm text-white/55">
              {games.isGameListCapped ? `The ${formatNumber(games.gameLimit)} most recently played of ${formatNumber(games.games)}.` : `All ${formatNumber(games.games)}, most recently played first.`} Open one to see its achievements and scores.
              {games.cloudSaves ? ` ${formatNumber(games.cloudSaves)} cloud-save ${games.cloudSaves === 1 ? "entry is" : "entries are"} counted, not opened.` : ""}
            </p>
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-72"
              placeholder="Search games"
            />
          </label>
        </div>
        <ExpandableList items={filteredGames} initial={10} noun="games">
          {(visible) => visible.map((game) => <PlayGameRow key={game.id} game={game} privacyMode={privacyMode} />)}
        </ExpandableList>
        {!filteredGames.length ? <p className="p-4 text-sm text-white/55">No games match that search.</p> : null}
      </div>
    </div>
  );
}

function MailSenderRow({ sender, privacyMode, showOpened }: { sender: GoogleMailSender; privacyMode: boolean; showOpened: boolean }) {
  const label = sender.name ?? sender.address;
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_90px_90px_120px_170px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(label, privacyMode, "Sender hidden")}</p>
        <p className="truncate text-xs text-white/55">
          {sender.name ? `${mask(sender.address, privacyMode, "address hidden")} / ` : ""}
          <span className={sender.kind === "automated" ? "text-[#c8dcff]" : "text-[#b8f3c9]"}>{sender.kind}</span>
          {sender.subscription ? " / mailing list" : ""}
          {sender.ignored ? " / never opened" : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
        <p className="text-sm text-white md:text-right">{formatNumber(sender.count)} <span className="text-xs text-white/45">msgs</span></p>
        <p className="text-xs text-white/55 md:text-right">{formatBytes(sender.bytes)}</p>
        <p className="text-xs text-white/55 md:text-right">{showOpened ? `${formatPercent(sender.count ? sender.opened / sender.count : 0)} opened` : `${formatNumber(sender.unread)} unread`}</p>
        <p className="w-full text-xs text-white/55 md:w-auto md:text-right">{formatShortDate(sender.firstDate)} to {formatShortDate(sender.lastDate)}</p>
      </div>
    </div>
  );
}

function MailDomainRow({ domain, privacyMode, showCount = true }: { domain: GoogleMailDomain; privacyMode: boolean; showCount?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_100px_90px_200px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(domain.domain, privacyMode, "Domain hidden")}</p>
        <p className="truncate text-xs text-white/55">{formatNumber(domain.senders)} sender address{domain.senders === 1 ? "" : "es"}</p>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
        <p className="text-sm text-white md:text-right">{showCount ? `${formatNumber(domain.count)} msgs` : formatBytes(domain.bytes)}</p>
        <p className="text-xs text-white/55 md:text-right">{showCount ? formatBytes(domain.bytes) : `${formatNumber(domain.count)} msgs`}</p>
        <p className="w-full text-xs text-white/55 md:w-auto md:text-right">{formatShortDate(domain.firstDate)} to {formatShortDate(domain.lastDate)}</p>
      </div>
    </div>
  );
}

function MailTab({ data, privacyMode, mailBodies }: { data: GoogleUnpackedData; privacyMode: boolean; mailBodies?: MailBodiesControl }) {
  const [senderView, setSenderView] = useState<"senders" | "domains" | "size">("senders");
  const [granularity, setGranularity] = useState<"month" | "year">("month");
  const [section, setSection] = useState<"inbox" | "storage" | "purchases" | "security">("inbox");
  const mail = data.mail;

  if (!mail?.parsedFiles || !mail.messages) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        {mail?.warnings.length
          ? `The Gmail files in this export could not be read. ${mail.warnings[0]}`
          : "No Gmail mailbox (.mbox) was found in this export. Include the Mail ZIP part from your Takeout to see this tab."}
      </div>
    );
  }

  const chartData = granularity === "year" ? mail.byYear : mail.byMonth;
  const maxChartValue = Math.max(...chartData.map((item) => item.count), 1);
  const automatedShare = mail.received ? mail.automated / mail.received : 0;
  const rangeDetail = mail.dateRange ? `${formatShortDate(mail.dateRange.start)} to ${formatShortDate(mail.dateRange.end)}` : "No dated messages";
  const maxFootprint = Math.max(...mail.footprint.newDomainsByYear.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Messages" value={formatNumber(mail.messages)} detail={`${formatNumber(mail.threads)} conversations / ${formatNumber(mail.sent)} sent`} icon={Mail} tone="red" />
        <StatTile label="Automated" value={formatPercent(automatedShare)} detail={`${formatNumber(mail.automated)} automated / ${formatNumber(mail.personal)} from people`} icon={Database} tone="yellow" />
        <StatTile label="Mailing lists" value={formatNumber(mail.subscriptionSenders)} detail={mail.hasOpenedData ? `${formatNumber(mail.ignoredSubscriptionSenders)} you never opened (${formatNumber(mail.ignoredSubscriptionMessages)} messages)` : "Senders with unsubscribe headers"} icon={Inbox} tone="green" />
        <StatTile label="Mailbox size" value={formatBytes(mail.totalBytes)} detail={`${formatNumber(mail.withAttachments)} messages carry attachments`} icon={Archive} />
      </div>

      <div className="rounded-lg border border-[#ea4335]/30 bg-[#ea4335]/10 p-4 text-sm leading-6 text-[#ffc6bf]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        Built from message headers only ({rangeDetail}). The scan streams through the mailbox once and keeps small per-sender counts; it does not keep or display message bodies{mail.spend ? " (the opt-in order totals read the text of order emails and keep only the amounts)" : ""}, and there is no inbox reader or search because Gmail already does that. Times use your browser&apos;s local time zone.
        {mail.duplicatesSkipped ? ` ${formatNumber(mail.duplicatesSkipped)} duplicate copies across mailbox files were skipped.` : ""}
      </div>

      {mail.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {formatNumber(mail.malformedFiles)} mail file{mail.malformedFiles === 1 ? "" : "s"} could not be read. {mail.warnings[0]}
        </div>
      ) : null}

      <div className="flex gap-2 overflow-x-auto">
        {([
          ["inbox", "Inbox and timing"],
          ["storage", "Storage and attachments"],
          ["purchases", "Purchases and deliveries"],
          ["security", "Security trail"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${section === id ? "bg-[#ea4335] text-white" : "border border-white/10 bg-[#15171b] text-white/60 hover:text-white"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "storage" ? <MailStorageSection mail={mail} privacyMode={privacyMode} /> : null}
      {section === "purchases" ? <MailPurchasesSection mail={mail} privacyMode={privacyMode} mailBodies={mailBodies} /> : null}
      {section === "security" ? <MailSecuritySection mail={mail} privacyMode={privacyMode} /> : null}

      {section === "inbox" ? (
        <>
      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Who fills your inbox</h2>
            <p className="text-sm text-white/55">
              {formatNumber(mail.uniqueSenders)} sender addresses across {formatNumber(mail.uniqueDomains)} domains.
              {mail.account ? ` Mailbox: ${mask(mail.account, privacyMode, "hidden")}.` : ""}
            </p>
          </div>
          <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
            {([
              ["senders", "Senders"],
              ["domains", "Domains"],
              ["size", "By size"],
            ] as const).map(([option, label]) => (
              <button
                key={option}
                type="button"
                onClick={() => setSenderView(option)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition ${senderView === option ? "bg-[#ea4335] text-white" : "text-white/60 hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          {senderView === "senders" ? <ExpandableList key="senders" items={mail.topSenders} initial={10} noun="senders">{(visible) => visible.map((sender) => <MailSenderRow key={sender.address} sender={sender} privacyMode={privacyMode} showOpened={mail.hasOpenedData} />)}</ExpandableList> : null}
          {senderView === "domains" ? <ExpandableList key="domains" items={mail.topDomains} initial={10} noun="domains">{(visible) => visible.map((domain) => <MailDomainRow key={domain.domain} domain={domain} privacyMode={privacyMode} />)}</ExpandableList> : null}
          {senderView === "size" ? <ExpandableList key="size" items={mail.topDomainsBySize} initial={10} noun="domains">{(visible) => visible.map((domain) => <MailDomainRow key={domain.domain} domain={domain} privacyMode={privacyMode} showCount={false} />)}</ExpandableList> : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Subscription audit</h2>
            <p className="text-sm text-white/55">
              {mail.hasOpenedData
                ? `Mailing lists (senders with unsubscribe headers) you never opened, listed first. Together they sent ${formatNumber(mail.ignoredSubscriptionMessages)} messages taking ${formatBytes(mail.ignoredSubscriptionBytes)}. A sender needs at least 3 messages to count as ignored.`
                : "This export has no Opened labels, so every mailing list is shown by volume and \"never opened\" cannot be worked out."}
            </p>
          </div>
          <div>
            <ExpandableList items={mail.subscriptions} initial={10} noun="mailing lists">
              {(visible) => visible.map((sender) => <MailSenderRow key={sender.address} sender={sender} privacyMode={privacyMode} showOpened={mail.hasOpenedData} />)}
            </ExpandableList>
            {!mail.subscriptions.length ? <p className="p-4 text-sm text-white/55">No mailing-list senders were found.</p> : null}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Labels</h2>
          <p className="mt-1 text-xs text-white/55">Gmail system labels and categories. A message can carry several.</p>
          <div className="mt-4">
            <BarRows items={mail.labels} privacyMode={privacyMode} initial={8} />
          </div>
          {mail.userLabels.length ? (
            <>
              <h3 className="mt-5 text-sm font-bold text-white">Your own labels</h3>
              <div className="mt-3">
                <BarRows items={mail.userLabels} privacyMode={privacyMode} privateLabels initial={8} />
              </div>
            </>
          ) : null}
          {mail.settings ? (
            <p className="mt-5 text-xs text-white/55">
              Settings on record: {formatNumber(mail.settings.filters)} filter{mail.settings.filters === 1 ? "" : "s"}, {formatNumber(mail.settings.blockedAddresses)} blocked address{mail.settings.blockedAddresses === 1 ? "" : "es"}, {formatNumber(mail.settings.forwardingAddresses)} forwarding address{mail.settings.forwardingAddresses === 1 ? "" : "es"} (contents not shown).
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">Mail over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#ea4335] text-white" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" name="Messages" fill="#ea4335" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {mail.busiestDay ? <p className="mt-3 text-sm text-white/55">Busiest day: {formatNumber(mail.busiestDay.count)} messages on {mail.busiestDay.date}</p> : null}
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Spikes</h2>
          <p className="mt-1 text-xs text-white/55">Months far above your usual volume, and who caused them.</p>
          <div className="mt-4 space-y-3">
            {mail.spikes.length ? (
              <ExpandableList items={mail.spikes} initial={4} noun="spikes">{(visible) => visible.map((spike) => (
                <div key={spike.month} className="rounded-lg border border-white/10 bg-[#0d0f14] p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-white">{spike.month}</span>
                    <span className="text-sm text-white/70">{formatNumber(spike.count)} messages</span>
                  </div>
                  {spike.topSender ? (
                    <p className="mt-1 truncate text-xs text-white/55">
                      Mostly {mask(spike.topSender, privacyMode, "a sender (hidden)")} ({formatNumber(spike.topSenderCount ?? 0)})
                    </p>
                  ) : null}
                </div>
              ))}</ExpandableList>
            ) : (
              <p className="text-sm text-white/55">Your volume is steady, with no month far above the rest.</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Day of week</h2>
          <div className="mt-4">
            <ColumnChart items={mail.byWeekday} color="#ea4335" />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={mail.byHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...mail.byHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" name="Messages" fill="#ea4335" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <h2 className="text-lg font-bold text-white">Account footprint</h2>
        <p className="mt-1 text-sm text-white/55">
          {formatNumber(mail.footprint.accountDomains)} services have emailed you at least twice (personal mail providers left out). The year a service first wrote to you is a good proxy for when you signed up.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {mail.footprint.newDomainsByYear.map((year) => (
            <div key={year.label} className="rounded-lg border border-white/10 bg-[#0d0f14] p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-white">{year.label}</span>
                <span className="text-xs text-white/55">{formatNumber(year.count)} new</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[#ea4335]" style={{ width: `${Math.max(4, Math.round((year.count / maxFootprint) * 100))}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Oldest services</h2>
            <p className="text-sm text-white/55">The first services that ever emailed you.</p>
          </div>
          <div>
            <ExpandableList items={mail.footprint.oldest} initial={6} noun="services">
              {(visible) => visible.map((domain) => <MailDomainRow key={domain.domain} domain={domain} privacyMode={privacyMode} />)}
            </ExpandableList>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Gone quiet</h2>
            <p className="text-sm text-white/55">Services with at least 3 emails whose last message is over {formatNumber(mail.footprint.quietMonths)} months older than your newest one. Accounts you may have forgotten.</p>
          </div>
          <div>
            <ExpandableList items={mail.footprint.quiet} initial={6} noun="services">
              {(visible) => visible.map((domain) => <MailDomainRow key={domain.domain} domain={domain} privacyMode={privacyMode} />)}
            </ExpandableList>
            {!mail.footprint.quiet.length ? <p className="p-4 text-sm text-white/55">Nothing has gone quiet for that long.</p> : null}
          </div>
        </div>
      </div>
        </>
      ) : null}
    </div>
  );
}

const STACK_COLORS = ["#ea4335", "#4285f4", "#fbbc04", "#34a853", "#a142f4", "#24c1e0", "#9aa0a6"];

function MailStorageSection({ mail, privacyMode }: { mail: GoogleMailSummary; privacyMode: boolean }) {
  const { storage } = mail;
  const maxTypeBytes = Math.max(...storage.byType.map((item) => item.bytes), 1);
  const biggest = storage.largest[0];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Attachments" value={formatNumber(storage.attachmentCount)} detail={`in ${formatNumber(mail.withAttachments)} messages`} icon={Archive} tone="red" />
        <StatTile label="Attachment size" value={formatBytes(storage.attachmentBytes)} detail={`about ${formatPercent(storage.attachmentShare)} of the ${formatBytes(mail.totalBytes)} mailbox (estimated)`} icon={Database} tone="yellow" />
        <StatTile label="Largest message" value={biggest ? formatBytes(biggest.bytes) : "0 B"} detail={biggest ? `${formatNumber(biggest.attachments)} attachment${biggest.attachments === 1 ? "" : "s"}, ${formatShortDate(biggest.date)}` : "No messages"} icon={FileWarning} />
        <StatTile label="File types" value={formatNumber(storage.byType.length)} detail={storage.byType[0] ? `Most space: .${storage.byType[0].extension}` : "No attachments found"} icon={FolderTree} tone="green" />
      </div>

      <div className="rounded-lg border border-[#ea4335]/30 bg-[#ea4335]/10 p-4 text-sm leading-6 text-[#ffc6bf]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        Attachment sizes are estimated from the length of each attachment&apos;s encoded lines, so the files themselves are never decoded or opened. The estimate runs a little high or low for unusual encodings. Inline images and signature logos are not counted.
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Attachment types</h2>
          <p className="mt-1 text-xs text-white/55">Ranked by estimated size, from the file extension.</p>
          <div className="mt-4 space-y-3">
            {storage.byType.length ? (
              <ExpandableList items={storage.byType} initial={8} noun="types">{(visible) => visible.map((item) => (
                <div key={item.extension} className="grid grid-cols-[56px_minmax(0,1fr)_120px] items-center gap-3">
                  <span className="truncate text-xs font-semibold text-white">{item.extension === "(none)" || item.extension === "(unknown)" ? item.extension : `.${item.extension}`}</span>
                  <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-[#ea4335]" style={{ width: `${Math.max(4, Math.round((item.bytes / maxTypeBytes) * 100))}%` }} />
                  </div>
                  <span className="text-right text-xs text-white/55">
                    {formatNumber(item.count)} / {formatBytes(item.bytes)}
                  </span>
                </div>
              ))}</ExpandableList>
            ) : (
              <p className="text-sm text-white/55">No attachments were found in this mailbox.</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Largest messages</h2>
            <p className="text-sm text-white/55">The 15 biggest single messages. Subjects are kept for these only.</p>
          </div>
          <div>
            <ExpandableList items={storage.largest} initial={5} noun="messages">{(visible) => visible.map((item, index) => (
              <div key={`${item.sender}-${item.date}-${index}`} className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_90px_110px_130px] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{item.subject ? mask(item.subject, privacyMode, "Subject hidden") : "(no subject)"}</p>
                  <p className="truncate text-xs text-white/55">{mask(item.name ?? item.sender, privacyMode, "Sender hidden")}</p>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
                  <p className="text-sm text-white md:text-right">{formatBytes(item.bytes)}</p>
                  <p className="text-xs text-white/55 md:text-right">{formatNumber(item.attachments)} attachment{item.attachments === 1 ? "" : "s"}</p>
                  <p className="text-xs text-white/55 md:text-right">{formatShortDate(item.date)}</p>
                </div>
              </div>
            ))}</ExpandableList>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatOrderMoney(amount: number, currency?: string): string {
  if (!currency) return numberFormatter.format(amount);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: amount >= 1000 ? 0 : 2 }).format(amount);
  } catch {
    return `${numberFormatter.format(amount)} ${currency}`;
  }
}

function MailSpendOptIn({ control, orderEmails }: { control: MailBodiesControl; orderEmails: number }) {
  const running = control.status === "running";
  return (
    <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">See what you spent (optional)</h2>
          <p className="mt-1 text-sm leading-6 text-[#ffe48a]">
            This reads the text of your {formatNumber(orderEmails)} order and receipt emails to find each order&apos;s total. Every other email is skipped. Only the shop, date, and amount are kept, no message text is stored, and nothing leaves your browser. It re-scans the mailbox, which can take a few seconds to a minute.
          </p>
        </div>
        <Button type="button" onClick={control.onStart} disabled={running} className="w-fit shrink-0 bg-[#fbbc04] text-[#15171b] hover:bg-[#ffd04d]">
          {running ? "Reading order emails" : control.status === "failed" ? "Try again" : "Read order emails"}
        </Button>
      </div>
      {running ? (
        <div className="mt-3" role="status">
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-[#fbbc04] transition-all" style={{ width: `${Math.max(3, Math.min(100, control.percent))}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-white/60">{control.label}</p>
        </div>
      ) : null}
      {control.status === "failed" ? (
        <p className="mt-3 text-sm text-[#ffc6bf]" role="alert">
          {control.error ?? "The order emails could not be read."}
        </p>
      ) : null}
    </div>
  );
}

function MailSpendSection({ spend, privacyMode }: { spend: GoogleMailSpend; privacyMode: boolean }) {
  const { currency } = spend;
  const others = spend.currencies.filter((item) => item.currency !== currency);
  const missing = Math.max(0, spend.readable - spend.orders - spend.duplicates);

  if (!spend.orders || !currency) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4 text-sm leading-6 text-white/65">
        The text of {formatNumber(spend.scanned)} order emails was read, but no order total could be found in them, so there are no amounts to show.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Spent" value={formatOrderMoney(spend.total, currency)} detail={`across ${formatNumber(spend.currencies.find((item) => item.currency === currency)?.orders ?? spend.orders)} orders, in ${currency}`} icon={ShoppingBag} tone="yellow" />
        <StatTile label="Average order" value={formatOrderMoney(spend.average, currency)} detail={`${formatNumber(spend.merchantCount)} ${spend.merchantCount === 1 ? "shop" : "shops"}`} icon={TrendingUp} tone="green" />
        <StatTile
          label="Biggest order"
          value={spend.biggest ? formatOrderMoney(spend.biggest.amount, currency) : "None"}
          detail={spend.biggest ? `${mask(spend.biggest.name ?? spend.biggest.domain, privacyMode, "Shop hidden")}, ${formatShortDate(spend.biggest.date)}` : "No orders"}
          icon={Flame}
          tone="red"
        />
        <StatTile label="Order emails read" value={formatNumber(spend.scanned)} detail={`${formatNumber(spend.orders)} had a total${spend.duplicates ? `, ${formatNumber(spend.duplicates)} repeats merged` : ""}`} icon={Inbox} />
      </div>

      <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        These are estimates read from the wording of each email. The total on the order is used (for food orders that includes fees and tips), and the same order sent twice on the same day is counted once. {formatNumber(missing)} of the emails had no total to read, usually delivery updates and receipts without an amount.
        {others.length ? ` Orders in other currencies are not added in: ${others.map((item) => `${formatNumber(item.orders)} in ${item.currency} (${formatOrderMoney(item.total, item.currency)})`).join(", ")}.` : ""}
        {spend.noCurrency ? ` ${formatNumber(spend.noCurrency)} totals had no currency and are left out.` : ""}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Spent per month</h2>
          <p className="mt-1 text-xs text-white/55">In {currency}, by the date of the email.</p>
          <div className="mt-4">
            <ColumnChart items={fillMonths(spend.byMonth)} color="#fbbc04" tickGap={28} />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Spent per year</h2>
          <p className="mt-1 text-xs text-white/55">In {currency}. The latest year may be partial.</p>
          <div className="mt-4">
            <ColumnChart items={spend.byYear} color="#fbbc04" />
          </div>
        </div>
      </div>

      {spend.repeating.length ? (
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Charges that keep coming back</h2>
          <p className="mt-1 text-xs text-white/55">The same amount from the same shop in at least three different months.</p>
          <div className="mt-3 divide-y divide-white/10">
            <ExpandableList items={spend.repeating} initial={5} noun="charges">{(visible) => visible.map((item, index) => (
              <div key={item.domain} className="grid grid-cols-1 gap-1 py-2.5 md:grid-cols-[minmax(0,1fr)_110px_110px_170px] md:items-center md:gap-3">
                <p className="truncate text-sm font-semibold text-white">{mask(item.name ?? item.domain, privacyMode, `Shop ${index + 1}`)}</p>
                <p className="text-sm text-white md:text-right">{formatOrderMoney(item.amount, currency)}</p>
                <p className="text-xs text-white/55 md:text-right">{formatNumber(item.months)} months</p>
                <p className="text-xs text-white/55 md:text-right">
                  {item.first} to {item.last}
                </p>
              </div>
            ))}</ExpandableList>
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Where the money went</h2>
          <p className="text-sm text-white/55">
            {spend.merchantCount > spend.merchants.length ? `The ${formatNumber(spend.merchants.length)} biggest of ${formatNumber(spend.merchantCount)} shops, in ${currency}.` : `All ${formatNumber(spend.merchantCount)} ${spend.merchantCount === 1 ? "shop" : "shops"}, in ${currency}.`}
          </p>
        </div>
        <ExpandableList items={spend.merchants} initial={10} noun="shops">
          {(visible) =>
            visible.map((merchant, index) => (
              <div key={merchant.domain} className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_100px_90px_110px_190px] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{mask(merchant.name ?? merchant.domain, privacyMode, `Shop ${index + 1}`)}</p>
                  <p className="truncate text-xs text-white/55">{mask(merchant.domain, privacyMode, "domain hidden")}</p>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
                  <p className="text-sm font-semibold text-white md:text-right">{formatOrderMoney(merchant.total, currency)}</p>
                  <p className="text-xs text-white/55 md:text-right">{formatNumber(merchant.orders)} {merchant.orders === 1 ? "order" : "orders"}</p>
                  <p className="text-xs text-white/55 md:text-right">avg {formatOrderMoney(merchant.average, currency)}</p>
                  <p className="w-full text-xs text-white/55 md:w-auto md:text-right">
                    {formatShortDate(merchant.first)} to {formatShortDate(merchant.last)}
                  </p>
                </div>
              </div>
            ))
          }
        </ExpandableList>
      </div>
    </div>
  );
}

function MailPurchasesSection({ mail, privacyMode, mailBodies }: { mail: GoogleMailSummary; privacyMode: boolean; mailBodies?: MailBodiesControl }) {
  const { purchases } = mail;
  const names = new Map(purchases.merchants.map((merchant) => [merchant.domain, merchant.name ?? merchant.domain]));
  const stackLabel = (domain: string, index: number) => mask(names.get(domain) ?? domain, privacyMode, `Merchant ${index + 1}`);
  const stackData = useMemo(
    () =>
      purchases.months.map((month) => {
        const row: Record<string, number | string> = { label: month.label };
        let used = 0;
        purchases.stackMerchants.forEach((domain, index) => {
          const count = month.byMerchant[domain] ?? 0;
          row[`m${index}`] = count;
          used += count;
        });
        row.other = Math.max(0, month.total - used);
        return row;
      }),
    [purchases.months, purchases.stackMerchants],
  );
  const maxMonth = Math.max(...purchases.months.map((month) => month.total), 1);
  const top = purchases.merchants[0];

  if (!purchases.messages) {
    return <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">No purchase, receipt, or delivery emails were recognised in this mailbox.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Order emails" value={formatNumber(purchases.messages)} detail={`${formatNumber(purchases.labelled)} in Gmail's Purchases category, ${formatNumber(purchases.subjectOnly)} found by subject`} icon={ShoppingBag} tone="yellow" />
        <StatTile label="Merchants" value={formatNumber(purchases.merchantCount)} detail="Distinct sender domains" icon={FolderTree} tone="green" />
        <StatTile label="Delivery updates" value={formatNumber(purchases.shipping)} detail="Shipped, dispatched, out for delivery, delivered" icon={Route} />
        <StatTile label="Top merchant" value={top ? formatNumber(top.count) : "0"} detail={top ? mask(top.name ?? top.domain, privacyMode, "Merchant hidden") : "None"} icon={TrendingUp} tone="red" />
      </div>

      <div className="rounded-lg border border-[#ea4335]/30 bg-[#ea4335]/10 p-4 text-sm leading-6 text-[#ffc6bf]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        {mail.spend
          ? "The counts in this section are emails, not orders. "
          : "These are counts of emails, not orders, and amounts are not shown: totals live inside message bodies, which are only read if you choose to below. "}
        An email is counted if Gmail put it in Purchases or an automated sender&apos;s subject looks like an order, receipt, payment, booking, or delivery notice, so one order can produce several emails and a few unrelated emails may slip in.
      </div>

      {mail.spend ? <MailSpendSection spend={mail.spend} privacyMode={privacyMode} /> : mailBodies ? <MailSpendOptIn control={mailBodies} orderEmails={purchases.messages} /> : null}

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <h2 className="text-lg font-bold text-white">Order emails per month</h2>
        <p className="mt-1 text-xs text-white/55">Your six busiest merchants, with everyone else grouped as Other.</p>
        <div className="mt-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stackData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxMonth)} />
              <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
              {purchases.stackMerchants.map((domain, index) => (
                <Bar key={domain} dataKey={`m${index}`} name={stackLabel(domain, index)} stackId="purchases" fill={STACK_COLORS[index]} />
              ))}
              <Bar dataKey="other" name="Other" stackId="purchases" fill={STACK_COLORS[6]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/65">
          {purchases.stackMerchants.map((domain, index) => (
            <span key={domain} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: STACK_COLORS[index] }} />
              {stackLabel(domain, index)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: STACK_COLORS[6] }} />
            Other
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Merchants</h2>
          <p className="text-sm text-white/55">The {formatNumber(purchases.merchants.length)} merchants with the most order emails.</p>
        </div>
        <div>
          <ExpandableList items={purchases.merchants} initial={10} noun="merchants">{(visible) => visible.map((merchant, index) => (
            <div key={merchant.domain} className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_90px_110px_150px_190px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mask(merchant.name ?? merchant.domain, privacyMode, `Merchant ${index + 1}`)}</p>
                <p className="truncate text-xs text-white/55">{mask(merchant.domain, privacyMode, "domain hidden")}</p>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 md:contents">
                <p className="text-sm text-white md:text-right">{formatNumber(merchant.count)} <span className="text-xs text-white/45">emails</span></p>
                <p className="text-xs text-white/55 md:text-right">{formatNumber(merchant.shipping)} delivery</p>
                <p className="text-xs text-white/55 md:text-right">{merchant.peakMonth ? `Peak ${merchant.peakMonth} (${formatNumber(merchant.peakCount ?? 0)})` : `${formatNumber(merchant.activeMonths)} months`}</p>
                <p className="w-full text-xs text-white/55 md:w-auto md:text-right">{formatShortDate(merchant.firstDate)} to {formatShortDate(merchant.lastDate)}</p>
              </div>
            </div>
          ))}</ExpandableList>
        </div>
      </div>
    </div>
  );
}

function MailSecuritySection({ mail, privacyMode }: { mail: GoogleMailSummary; privacyMode: boolean }) {
  const { security } = mail;
  const maxMonth = Math.max(...security.byMonth.map((item) => item.count), 1);
  const kindCount = (label: string) => security.byKind.find((item) => item.label === label)?.count ?? 0;

  if (!security.messages) {
    return <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">No sign-in alerts, password emails, or verification-code emails were recognised in this mailbox.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Security emails" value={formatNumber(security.messages)} detail={`${formatShortDate(security.firstDate)} to ${formatShortDate(security.lastDate)}`} icon={ShieldCheck} tone="red" />
        <StatTile label="Sign-in alerts" value={formatNumber(kindCount("Sign-in alerts"))} detail="New sign-ins, devices, and locations" icon={LockKeyhole} tone="yellow" />
        <StatTile label="Password emails" value={formatNumber(kindCount("Password changes and resets"))} detail={`from ${formatNumber(security.passwordServices)} services`} icon={EyeOff} tone="green" />
        <StatTile label="Suspicious" value={formatNumber(kindCount("Suspicious activity"))} detail="Unusual, blocked, or &quot;not you&quot; notices" icon={AlertTriangle} />
      </div>

      <div className="rounded-lg border border-[#ea4335]/30 bg-[#ea4335]/10 p-4 text-sm leading-6 text-[#ffc6bf]">
        <ShieldCheck className="mr-2 inline size-4" aria-hidden="true" />
        Found by matching subject lines from automated senders (for example &quot;new sign-in&quot;, &quot;reset your password&quot;, &quot;verification code&quot;). Codes and message text are never read. Wording changes by service and language, so treat the counts as a floor.
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
        <h2 className="text-lg font-bold text-white">Security emails per month</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={security.byMonth} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxMonth)} />
              <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
              <Bar dataKey="count" name="Emails" fill="#ea4335" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">What kind</h2>
          <div className="mt-4">
            <BarRows items={security.byKind} privacyMode={privacyMode} />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Who sends them</h2>
          <div className="mt-4">
            <BarRows items={security.topSources} privacyMode={privacyMode} privateLabels initial={8} />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMoney(total: number, currency: string): string {
  const symbol = currency.length <= 2 ? currency : `${currency} `;
  return `${symbol}${total.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PlayInstallRow({ entry, privacyMode }: { entry: GooglePlayInstall; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "App hidden")}</p>
        <p className="truncate text-xs text-white/55">{entry.documentType ?? "App"}</p>
      </div>
      <p className="truncate text-xs text-white/55">{entry.device ? mask(deviceDisplayName(entry.device), privacyMode, "device hidden") : "Unknown device"}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.firstInstalledAt)}</p>
    </div>
  );
}

function PlayPurchaseRow({ entry, privacyMode }: { entry: GooglePlayPurchase; privacyMode: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_100px_160px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{mask(entry.title, privacyMode, "Item hidden")}</p>
        <p className="truncate text-xs text-white/55">
          {entry.documentType ?? "Item"}
          {entry.paymentMethod ? ` / ${privacyMode ? "payment hidden" : entry.paymentMethod}` : ""}
        </p>
      </div>
      <p className="text-sm font-semibold text-white">{entry.price ?? "Unknown"}</p>
      <p className="text-xs text-white/55 md:text-right">{formatDate(entry.time)}</p>
    </div>
  );
}

function PlayStoreTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [query, setQuery] = useState("");
  const play = data.playStore;
  const filteredInstalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (play?.installs.recent ?? []).filter((entry) => !q || [entry.title, entry.device, entry.documentType].some((value) => value?.toLowerCase().includes(q)));
  }, [play?.installs.recent, query]);

  if (!play) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No Google Play Store files (<code>Installs.json</code>, <code>Purchase History.json</code>, and related) were found in this export.
      </div>
    );
  }

  const spendText = play.purchases.spend.length ? play.purchases.spend.map((item) => formatMoney(item.total, item.currency)).join(" + ") : "None";
  const maxInstallYear = Math.max(...play.installs.byYear.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Installs" value={formatNumber(play.installs.total)} detail={`${formatNumber(play.installs.uniqueApps)} unique apps / ${formatNumber(play.installs.multiDeviceApps)} on 2+ devices`} icon={Smartphone} tone="green" />
        <StatTile label="Spend" value={spendText} detail={`${formatNumber(play.purchases.paid)} paid of ${formatNumber(play.purchases.total)} purchases`} icon={ShoppingBag} tone="yellow" />
        <StatTile label="Library" value={formatNumber(play.library.total)} detail={`${formatNumber(play.orders.total)} orders on record`} icon={Archive} />
        <StatTile label="Devices" value={formatNumber(play.devices.length)} detail={play.playPoints?.level ? `Play Points ${play.playPoints.level}${play.playPoints.balance !== undefined ? `, ${formatNumber(play.playPoints.balance)} pts` : ""}` : "Registered to the account"} icon={Database} tone="red" />
      </div>

      {play.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {play.warnings[0]}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Installs by first-install year</h2>
          <p className="mt-1 text-xs text-white/55">An app on two phones counts twice. Reinstalls after a phone change show up as a spike.</p>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={play.installs.byYear} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxInstallYear)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#34a853" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Installs by device</h2>
          <div className="mt-4">
            <BarRows items={play.installs.byDevice.map((item) => ({ ...item, label: deviceDisplayName(item.label) }))} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Purchases by year</h2>
          <div className="mt-4">
            <ColumnChart items={play.purchases.byYear} color="#34a853" />
          </div>
          {play.purchases.byType.length ? (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h3 className="text-sm font-bold text-white">By type</h3>
              <div className="mt-3">
                <BarRows items={play.purchases.byType} privacyMode={privacyMode} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Biggest purchases</h2>
          <div className="mt-4 space-y-2">
            {play.purchases.topPaid.length ? (
              play.purchases.topPaid.slice(0, 6).map((item, index) => (
                <div key={`${item.title}-${item.time ?? index}`} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#0d0f14] p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{mask(item.title, privacyMode, "Item hidden")}</p>
                    <p className="text-xs text-white/55">{formatDate(item.time)}</p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-[#ffe48a]">{item.price}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-white/55">No paid purchases found.</p>
            )}
          </div>
          {play.purchases.paymentMethods.length ? (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h3 className="text-sm font-bold text-white">Payment methods</h3>
              <div className="mt-3">
                <BarRows items={play.purchases.paymentMethods} privacyMode={privacyMode} privateLabels />
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Subscriptions</h2>
          <div className="mt-4 space-y-2">
            {play.subscriptions.length ? (
              play.subscriptions.map((sub, index) => (
                <div key={`${sub.title}-${index}`} className="rounded-lg border border-white/10 bg-[#0d0f14] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-white">{mask(sub.title, privacyMode, "Subscription hidden")}</p>
                    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${sub.state === "Active" ? statusClass("parsed") : statusClass("skipped")}`}>{sub.state ?? "Unknown"}</span>
                  </div>
                  <p className="mt-1 text-xs text-white/55">
                    {sub.price ?? "Price unknown"}
                    {sub.period ? ` per ${sub.period}` : ""}
                    {sub.renewalDate ? ` / renews ${formatDate(sub.renewalDate)}` : sub.expirationDate ? ` / ended ${formatDate(sub.expirationDate)}` : ""}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-white/55">No subscriptions on record.</p>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Devices registered to Play</h2>
        </div>
        <div className="divide-y divide-white/10">
          {play.devices.map((device, index) => (
            <div key={`${device.label}-${index}`} className="grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_150px_170px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mask(device.label, privacyMode, "Device hidden")}</p>
                <p className="truncate text-xs text-white/55">
                  {device.androidSdk ? `Android API ${device.androidSdk}` : "Android"}
                  {device.memoryGb ? ` / ${device.memoryGb} GB RAM` : ""}
                  {device.country ? ` / ${privacyMode ? "region hidden" : device.country}` : ""}
                </p>
              </div>
              <p className="text-xs text-white/55">Added {formatDate(device.registeredAt)}</p>
              <p className="text-xs text-white/55 md:text-right">Active {formatDate(device.lastActiveAt)}</p>
            </div>
          ))}
          {!play.devices.length ? <p className="p-4 text-sm text-white/55">No devices found.</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Purchase history</h2>
            <p className="text-sm text-white/55">{play.purchases.isCapped ? `Showing the newest ${formatNumber(play.purchases.recentLimit)}.` : "Showing every purchase."}</p>
          </div>
          <div>
            <ExpandableList items={play.purchases.recent.slice(0, 60)} noun="purchases">{(visible) => visible.map((entry, index) => (
              <PlayPurchaseRow key={`${entry.title}-${entry.time ?? index}`} entry={entry} privacyMode={privacyMode} />
            ))}</ExpandableList>
            {!play.purchases.recent.length ? <p className="p-4 text-sm text-white/55">No purchases on record.</p> : null}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Install history</h2>
              <p className="text-sm text-white/55">{play.installs.isCapped ? `Showing the newest ${formatNumber(play.installs.recentLimit)}.` : "Showing every install."}</p>
            </div>
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-64"
                placeholder="Search installs"
              />
            </label>
          </div>
          <div>
            <ExpandableList items={filteredInstalls.slice(0, 60)} noun="installs">{(visible) => visible.map((entry, index) => (
              <PlayInstallRow key={`${entry.title}-${entry.device ?? ""}-${entry.firstInstalledAt ?? index}`} entry={entry} privacyMode={privacyMode} />
            ))}</ExpandableList>
            {!filteredInstalls.length ? <p className="p-4 text-sm text-white/55">No installs match that search.</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#15171b]">
      <div className="flex flex-col gap-1 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-bold text-white">{title}</h2>
        {detail ? <p className="text-sm text-white/55">{detail}</p> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function MoreServicesTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [contactQuery, setContactQuery] = useState("");
  const more = data.moreServices;
  const contacts = more?.contacts;
  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    return (contacts?.list ?? []).filter((contact) => !q || [contact.name, contact.organization, ...contact.phones, ...contact.emails].some((value) => value?.toLowerCase().includes(q)));
  }, [contactQuery, contacts?.list]);

  if (!more || !(more.contacts || more.calendar || more.tasks || more.saved || more.pay || more.chat || more.contributions)) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No Contacts, Calendar, Tasks, Saved, Google Pay, Google Chat, or contribution files were found in this export.
      </div>
    );
  }

  const { calendar, tasks, saved, pay, chat, contributions } = more;
  const tiles: { label: string; value: string; detail: string; icon: LucideIcon; tone: "blue" | "green" | "yellow" | "red" }[] = [];
  if (contacts) tiles.push({ label: "Contacts", value: formatNumber(contacts.total), detail: `${formatNumber(contacts.withPhone)} with a phone / ${formatNumber(contacts.withEmail)} with an email`, icon: FolderTree, tone: "blue" });
  if (calendar) tiles.push({ label: "Calendar events", value: formatNumber(calendar.total), detail: `${formatNumber(calendar.recurring)} recurring / ${formatNumber(calendar.allDay)} all-day`, icon: CalendarDays, tone: "green" });
  if (pay) tiles.push({ label: "Google Pay", value: formatNumber(pay.total), detail: pay.spend.length ? `${pay.spend.map((item) => formatMoney(item.total, item.currency)).join(" + ")} completed` : "No completed charges", icon: ShoppingBag, tone: "yellow" });
  if (chat) tiles.push({ label: "Chat messages", value: formatNumber(chat.messages), detail: `${formatNumber(chat.conversations.length)} conversations / ${formatNumber(chat.sent)} sent`, icon: Activity, tone: "red" });
  if (saved) tiles.push({ label: "Saved items", value: formatNumber(saved.total), detail: `${formatNumber(saved.lists.length)} lists`, icon: Database, tone: "blue" });
  if (tasks) tiles.push({ label: "Tasks", value: formatNumber(tasks.total), detail: `${formatNumber(tasks.lists.length)} list${tasks.lists.length === 1 ? "" : "s"}, ${formatNumber(tasks.completed)} completed`, icon: Timer, tone: "green" });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </div>

      {more.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {more.warnings[0]}
        </div>
      ) : null}

      {contacts ? (
        <SectionCard title="Contacts" detail={`${formatNumber(contacts.exportFiles)} contact file${contacts.exportFiles === 1 ? "" : "s"} in the export; counting "All Contacts" so copies are not double-counted`}>
          <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-white/55">
              {formatNumber(contacts.withOrganization)} list an organization / {formatNumber(contacts.withPhoto)} have a photo. {contacts.isCapped ? `Showing the first ${formatNumber(contacts.list.length)} by name.` : ""}
            </p>
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
              <input
                value={contactQuery}
                onChange={(event) => setContactQuery(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-64"
                placeholder="Search contacts"
              />
            </label>
          </div>
          <ExpandableList items={filteredContacts.slice(0, 60)} noun="contacts">{(visible) => visible.map((contact, index) => (
            <div key={`${contact.name}-${index}`} className="grid grid-cols-1 gap-1 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center">
              <p className="truncate text-sm font-semibold text-white">{mask(contact.name, privacyMode, "Contact hidden")}</p>
              <p className="truncate text-xs text-white/55">{mask([...contact.phones, ...contact.emails].join(", ") || "No phone or email", privacyMode, "details hidden")}</p>
            </div>
          ))}</ExpandableList>
          {!filteredContacts.length ? <p className="p-4 text-sm text-white/55">No contacts match that search.</p> : null}
        </SectionCard>
      ) : null}

      {calendar ? (
        <SectionCard title="Calendar" detail={calendar.dateRange?.start && calendar.dateRange.end ? `${formatDate(calendar.dateRange.start)} to ${formatDate(calendar.dateRange.end)}` : `${formatNumber(calendar.total)} events`}>
          {calendar.byYear.length ? (
            <div className="border-b border-white/10 p-4">
              <ColumnChart items={calendar.byYear} />
            </div>
          ) : null}
          <ExpandableList items={calendar.list.slice(0, 40)} noun="events">{(visible) => visible.map((event, index) => (
            <div key={`${event.title}-${event.start ?? index}`} className="grid grid-cols-1 gap-1 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_170px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mask(event.title, privacyMode, "Event hidden")}</p>
                <p className="truncate text-xs text-white/55">
                  {event.allDay ? "All day" : "Timed"}
                  {event.recurring ? " / repeats" : ""}
                  {event.attendees ? ` / ${event.attendees} attendee${event.attendees === 1 ? "" : "s"}` : ""}
                  {event.location ? ` / ${privacyMode ? "location hidden" : event.location}` : ""}
                </p>
              </div>
              <p className="text-xs text-white/55 md:text-right">{formatDate(event.start)}</p>
            </div>
          ))}</ExpandableList>
        </SectionCard>
      ) : null}

      {pay ? (
        <SectionCard title="Google Pay transactions" detail={`${formatNumber(pay.total)} rows${pay.isCapped ? `, newest ${formatNumber(pay.list.length)} listed` : ""}`}>
          <div className="grid grid-cols-1 gap-5 border-b border-white/10 p-4 md:grid-cols-3">
            <div>
              <h3 className="text-sm font-bold text-white">By status</h3>
              <div className="mt-3"><BarRows items={pay.byStatus} privacyMode={privacyMode} /></div>
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">By product</h3>
              <div className="mt-3"><BarRows items={pay.byProduct} privacyMode={privacyMode} /></div>
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">By year</h3>
              <div className="mt-3"><ColumnChart items={pay.byYear} /></div>
            </div>
          </div>
          <ExpandableList items={pay.list.slice(0, 40)} noun="transactions">{(visible) => visible.map((tx, index) => (
            <div key={`${tx.id ?? "tx"}-${index}`} className="grid grid-cols-1 gap-1 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_110px_150px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mask(tx.description, privacyMode, "Charge hidden")}</p>
                <p className="truncate text-xs text-white/55">
                  {tx.product ?? "Google"}
                  {tx.status ? ` / ${tx.status}` : ""}
                  {tx.paymentMethod ? ` / ${privacyMode ? "payment hidden" : tx.paymentMethod}` : ""}
                </p>
              </div>
              <p className="text-sm font-semibold text-white">{tx.currency ? formatMoney(tx.amount, tx.currency) : tx.amount.toFixed(2)}</p>
              <p className="text-xs text-white/55 md:text-right">{formatDate(tx.time)}</p>
            </div>
          ))}</ExpandableList>
        </SectionCard>
      ) : null}

      {chat ? (
        <SectionCard title="Google Chat" detail={`${formatNumber(chat.sent)} sent / ${formatNumber(chat.received)} received`}>
          {chat.conversations.map((conversation) => (
            <div key={conversation.id} className="grid grid-cols-1 gap-1 border-b border-white/10 px-4 py-3 md:grid-cols-[minmax(0,1fr)_150px_170px] md:items-center">
              <p className="truncate text-sm font-semibold text-white">{mask(conversation.members.join(", ") || conversation.id, privacyMode, "Conversation hidden")}</p>
              <p className="text-xs text-white/55">{formatNumber(conversation.messages)} messages</p>
              <p className="text-xs text-white/55 md:text-right">{conversation.first ? `${formatDate(conversation.first)}` : "Undated"}</p>
            </div>
          ))}
          <div className="border-b border-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Recent messages</div>
          <ExpandableList items={chat.recent.slice(0, 30)} noun="messages">{(visible) => visible.map((message, index) => (
            <div key={`${message.time ?? "m"}-${index}`} className="grid grid-cols-1 gap-1 border-b border-white/10 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_170px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{mask(message.text || "(no text)", privacyMode, "Message hidden")}</p>
                <p className="truncate text-xs text-white/55">{message.fromSelf ? "You" : mask(message.sender, privacyMode, "sender hidden")}</p>
              </div>
              <p className="text-xs text-white/55 md:text-right">{formatDate(message.time)}</p>
            </div>
          ))}</ExpandableList>
        </SectionCard>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {saved ? (
          <SectionCard title="Saved lists" detail={`${formatNumber(saved.total)} items`}>
            {saved.lists.map((list) => (
              <div key={list.name} className="border-b border-white/10 px-4 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-semibold text-white">{list.name}</p>
                  <span className="text-xs text-white/55">{formatNumber(list.count)}</span>
                </div>
                {list.items.slice(0, 3).map((item, index) => (
                  <p key={`${item.title ?? item.url}-${index}`} className="mt-1 truncate text-xs text-white/55">{mask(item.title ?? item.url, privacyMode, "Saved item hidden")}</p>
                ))}
              </div>
            ))}
          </SectionCard>
        ) : null}
        {tasks ? (
          <SectionCard title="Tasks" detail={tasks.lists.join(", ")}>
            {tasks.list.length ? (
              <ExpandableList items={tasks.list.slice(0, 40)} noun="tasks">{(visible) => visible.map((task, index) => (
                <div key={`${task.title}-${index}`} className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 last:border-b-0">
                  <p className="truncate text-sm text-white">{mask(task.title, privacyMode, "Task hidden")}</p>
                  <span className="shrink-0 text-xs text-white/55">{task.status ?? "open"}</span>
                </div>
              ))}</ExpandableList>
            ) : (
              <p className="p-4 text-sm text-white/55">{formatNumber(tasks.lists.length)} task list found, but it contains no tasks.</p>
            )}
          </SectionCard>
        ) : null}
        {contributions ? (
          <SectionCard title="Search and shopping contributions" detail="Counts only">
            <div className="grid grid-cols-2 gap-3 p-4">
              <StatTile label="Search reviews" value={formatNumber(contributions.reviews)} detail="Written for places or results" icon={Search} tone="blue" />
              <StatTile label="Thumbs" value={formatNumber(contributions.thumbs)} detail="Up/down ratings" icon={TrendingUp} tone="green" />
              <StatTile label="Product reviews" value={formatNumber(contributions.productReviews)} detail="Google Shopping" icon={ShoppingBag} tone="yellow" />
              <StatTile label="Merchant reviews" value={formatNumber(contributions.merchantReviews)} detail="Google Shopping" icon={ShoppingBag} tone="red" />
            </div>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}

function YouTubeTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [query, setQuery] = useState("");
  const youtube = data.youtube;
  const chartData =
    granularity === "day"
      ? youtube?.activityByDay.map((item) => ({ label: item.date.slice(5), count: item.count })) ?? []
      : granularity === "week"
        ? youtube?.activityByWeek ?? []
        : granularity === "month"
          ? youtube?.activityByMonth ?? []
          : youtube?.activityByYear ?? [];
  const filteredWatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (youtube?.watch.recent ?? []).filter((entry) => {
      if (!q) return true;
      return [entry.title, entry.videoUrl, entry.channelName, entry.channelUrl].some((value) => value?.toLowerCase().includes(q));
    });
  }, [query, youtube?.watch.recent]);
  const filteredSearch = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (youtube?.search.recent ?? []).filter((entry) => {
      if (!q) return true;
      return [entry.query, entry.resultUrl].some((value) => value?.toLowerCase().includes(q));
    });
  }, [query, youtube?.search.recent]);

  if (!youtube) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#15171b] p-6 text-sm text-white/60">
        No YouTube watch-history or search-history files were found in this export.
      </div>
    );
  }

  const maxChartValue = Math.max(...chartData.map((item) => item.count), 1);
  const rewatchedItems: GoogleRankedItem[] = youtube.topRewatchedVideos.map((video) => ({ label: video.title, count: video.count }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Watches" value={formatNumber(youtube.watch.total)} detail={`${formatNumber(youtube.watch.adViews)} ad views / ${formatNumber(youtube.watch.removedOrUnavailable)} removed`} icon={PlayCircle} tone="red" />
        <StatTile label="Searches" value={formatNumber(youtube.search.total)} detail={`${formatNumber(youtube.search.distinctQueries)} distinct queries`} icon={Search} />
        <StatTile label="Channels" value={formatNumber(youtube.watch.distinctChannels)} detail={`${formatNumber(youtube.topChannels.length)} ranked channels shown`} icon={Activity} tone="green" />
        <StatTile label="Music share" value={formatPercent(youtube.musicWatchShare)} detail="Of non-ad, available watches" icon={TrendingUp} tone="yellow" />
      </div>

      {youtube.warnings.length ? (
        <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4 text-sm leading-6 text-[#ffe48a]">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden="true" />
          {youtube.warnings[0]}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-white">YouTube activity over time</h2>
            <div className="flex rounded-lg border border-white/10 bg-[#0d0f14] p-1">
              {(["day", "week", "month", "year"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGranularity(option)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${granularity === option ? "bg-[#ea4335] text-white" : "text-white/60 hover:text-white"}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(maxChartValue)} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Area type="monotone" dataKey="count" stroke="#ea4335" fill="#ea4335" fillOpacity={0.22} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Top channels</h2>
          <div className="mt-4">
            <BarRows items={youtube.topChannels} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Time of day</h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={youtube.activityByHour} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} interval={3} />
                <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} tickLine={false} axisLine={false} width={yAxisWidth(Math.max(...youtube.activityByHour.map((item) => item.count), 1))} />
                <Tooltip contentStyle={{ background: "#0d0f14", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, color: "#fff" }} />
                <Bar dataKey="count" fill="#ea4335" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Top searches</h2>
          <div className="mt-4">
            <BarRows items={youtube.topSearchQueries} privacyMode={privacyMode} privateLabels />
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
          <h2 className="text-lg font-bold text-white">Rewatched videos</h2>
          <div className="mt-4">
            {rewatchedItems.length ? <BarRows items={rewatchedItems} privacyMode={privacyMode} privateLabels /> : <p className="text-sm text-white/55">No repeated videos found in the parsed recent summary.</p>}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Recent YouTube rows</h2>
            <p className="text-sm text-white/55">Showing the standalone YouTube parser&apos;s capped watch and search samples.</p>
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-[#0d0f14] pl-9 pr-3 text-sm text-white placeholder:text-white/35 sm:w-80"
              placeholder="Search visible rows"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2">
          <div className="border-white/10 xl:border-r">
            <div className="border-b border-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Watch history</div>
            <ExpandableList items={filteredWatch.slice(0, 60)} noun="videos">{(visible) => visible.map((entry, index) => (
              <YouTubeWatchRow key={`${entry.time ?? "watch"}-${entry.videoUrl ?? index}`} entry={entry} privacyMode={privacyMode} />
            ))}</ExpandableList>
            {!filteredWatch.length ? <p className="p-4 text-sm text-white/55">No watch rows match that search.</p> : null}
          </div>
          <div>
            <div className="border-b border-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Search history</div>
            <ExpandableList items={filteredSearch.slice(0, 60)} noun="searches">{(visible) => visible.map((entry, index) => (
              <YouTubeSearchRow key={`${entry.time ?? "search"}-${entry.query ?? index}`} entry={entry} privacyMode={privacyMode} />
            ))}</ExpandableList>
            {!filteredSearch.length ? <p className="p-4 text-sm text-white/55">No search rows match that search.</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function CoverageTab({ data, privacyMode }: { data: GoogleUnpackedData; privacyMode: boolean }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="rounded-lg border border-white/10 bg-[#15171b]">
          <div className="border-b border-white/10 p-4">
            <h2 className="text-lg font-bold text-white">Product coverage</h2>
          </div>
          <div className="divide-y divide-white/10">
            {data.products.map((product) => (
              <div key={product.product} className="grid grid-cols-1 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_120px_120px_110px] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{mask(product.product, privacyMode, "Product hidden")}</p>
                  <p className="text-xs text-white/55">{formatNumber(product.files)} files / {product.extensions.map((item) => `${item.label} ${formatNumber(item.count)}`).join(", ")}</p>
                </div>
                <p className="text-sm text-white/65">{formatBytes(product.uncompressedSize)}</p>
                <p className="text-sm text-white/65">{formatNumber(product.parsed)} parsed</p>
                <span className={`w-fit rounded-md border px-2 py-1 text-xs font-semibold ${statusClass(product.serviceStatus)}`}>{product.serviceStatus}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-lg border border-white/10 bg-[#15171b] p-4">
            <h2 className="text-lg font-bold text-white">ZIP parts</h2>
            <div className="mt-4 space-y-2">
              {data.archives.map((archive) => (
                <div key={archive.fileName} className="rounded-lg border border-white/10 bg-[#0d0f14] p-3">
                  <p className="truncate text-sm font-semibold text-white">{archive.fileName}</p>
                  <p className="text-xs text-white/55">{formatNumber(archive.entries)} entries / {formatBytes(archive.size)}</p>
                </div>
              ))}
            </div>
          </div>
          {data.warnings.length ? (
            <div className="rounded-lg border border-[#fbbc04]/30 bg-[#fbbc04]/10 p-4">
              <h2 className="text-sm font-bold text-[#ffe48a]">Warnings</h2>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-[#ffe48a]">
                {data.warnings.slice(0, 8).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[#15171b]">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-bold text-white">Largest files</h2>
        </div>
        <div className="divide-y divide-white/10">
          <ExpandableList items={data.largestFiles.slice(0, 30)} noun="files">{(visible) => visible.map((file) => (
            <div key={`${file.sourceArchive}:${file.path}`} className="grid grid-cols-1 gap-2 p-4 md:grid-cols-[minmax(0,1fr)_130px_110px] md:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{mask(file.path, privacyMode, "Path hidden")}</p>
                <p className="text-xs text-white/55">{mask(file.product, privacyMode, "Product hidden")} / {file.reason ?? "Indexed"}</p>
              </div>
              <p className="text-sm text-white/65">{formatBytes(file.uncompressedSize)}</p>
              <span className={`w-fit rounded-md border px-2 py-1 text-xs font-semibold ${statusClass(file.status)}`}>{file.status}</span>
            </div>
          ))}</ExpandableList>
        </div>
      </div>
    </div>
  );
}

const SECTION_NAMES: Record<GoogleSectionKey, string> = { photos: "Google Photos", mail: "Gmail", fit: "Fit" };
const TAB_SECTION: Partial<Record<TabId, GoogleSectionKey>> = { photos: "photos", mail: "mail", fit: "fit" };

function sectionPending(data: GoogleUnpackedData, key: GoogleSectionKey): boolean {
  return Boolean(data.pending?.includes(key));
}

// Shown in place of a tab whose section is still being read in the background; the rest of the dashboard stays usable.
function SectionLoading({ name, status, onRetry }: { name: string; status?: GoogleSectionStatus; onRetry: () => void }) {
  const failed = status?.status === "failed";
  const percent = status?.status === "running" ? Math.max(2, Math.min(100, status.percent)) : 2;
  return (
    <div className="rounded-lg border border-white/10 bg-[#15171b] p-6">
      <div className="flex items-start gap-3">
        {failed ? <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[#ff8a80]" aria-hidden="true" /> : <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-[#4285f4]" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-white">{failed ? `${name} could not be read` : `Reading ${name} in the background`}</h2>
          <p className="mt-1 text-sm leading-6 text-white/60">
            {failed
              ? status.message
              : "This section is slower than the rest, so the dashboard opened without it. Everything else is ready to use now, and this page fills in by itself when it finishes."}
          </p>
          {failed ? (
            <Button type="button" variant="outline" className="mt-3 border-white/15 bg-[#0d0f14] text-white hover:bg-white/10" onClick={onRetry}>
              Try again
            </Button>
          ) : (
            <div className="mt-4" role="status">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full bg-[#4285f4] transition-all ${status?.status === "running" ? "" : "animate-pulse"}`} style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-white/55">{status?.status === "running" ? `${status.label}, ${Math.round(status.percent)}%` : "Waiting to start"}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionGate({ sectionKey, data, sections, children }: { sectionKey: GoogleSectionKey; data: GoogleUnpackedData; sections?: SectionsControl; children: ReactNode }) {
  if (!sectionPending(data, sectionKey)) return <>{children}</>;
  return <SectionLoading name={SECTION_NAMES[sectionKey]} status={sections?.status[sectionKey]} onRetry={() => sections?.onRetry(sectionKey)} />;
}

// A slim strip above the tabs, so it is clear from any tab that more is still arriving.
function BackgroundLoadBar({ data, sections }: { data: GoogleUnpackedData; sections?: SectionsControl }) {
  const pending = data.pending ?? [];
  if (!pending.length) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-[#4285f4]/30 bg-[#4285f4]/10 px-4 py-2.5 text-xs text-[#c8dcff]" role="status">
      <span className="inline-flex items-center gap-2 font-semibold">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Still reading in the background
      </span>
      {pending.map((key) => {
        const status = sections?.status[key];
        return (
          <span key={key} className={status?.status === "failed" ? "text-[#ffb4ab]" : undefined}>
            {SECTION_NAMES[key]}: {status?.status === "failed" ? "failed" : status?.status === "running" ? `${Math.round(status.percent)}%` : "waiting"}
          </span>
        );
      })}
    </div>
  );
}

function NavButton({ item, active, hasData, loading = false, onSelect, compact = false }: { item: NavItem; active: boolean; hasData: boolean; loading?: boolean; onSelect: (id: TabId) => void; compact?: boolean }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      title={hasData ? undefined : `${item.label}: nothing for this service in the uploaded export`}
      className={`flex w-full items-center gap-3 rounded-lg border-l-2 px-3 text-left text-sm font-semibold transition ${compact ? "py-3" : "py-2"} ${active ? "bg-white/10 text-white" : hasData ? "border-transparent text-white/65 hover:bg-white/5 hover:text-white" : "border-transparent text-white/35 hover:bg-white/5 hover:text-white/60"}`}
      style={active ? { borderLeftColor: item.accent } : undefined}
    >
      <Icon className="size-4 shrink-0" style={{ color: hasData || active ? item.accent : undefined }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-white/50" aria-label="still loading" /> : !hasData ? <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/30">none</span> : null}
      {active && compact ? <Check className="size-4 shrink-0 text-white/70" aria-hidden="true" /> : null}
    </button>
  );
}

function NavGroups({ tab, data, onSelect, compact = false }: { tab: TabId; data: GoogleUnpackedData; onSelect: (id: TabId) => void; compact?: boolean }) {
  return (
    <div className="space-y-4">
      {NAV_GROUPS.map((group, index) => (
        <div key={group.heading ?? `group-${index}`} className="space-y-1">
          {group.heading ? <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">{group.heading}</p> : null}
          {group.items.map((item) => (
            <NavButton key={item.id} item={item} active={tab === item.id} hasData={navHasData(item.id, data)} loading={Boolean(TAB_SECTION[item.id] && sectionPending(data, TAB_SECTION[item.id]!))} onSelect={onSelect} compact={compact} />
          ))}
        </div>
      ))}
    </div>
  );
}

function NavChip({ item, active, hasData, loading, onSelect }: { item: NavItem; active: boolean; hasData: boolean; loading: boolean; onSelect: (id: TabId) => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      className={`inline-flex shrink-0 snap-start items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold transition ${active ? "text-white" : hasData ? "border-white/10 bg-[#15171b] text-white/75" : "border-white/5 bg-[#15171b]/60 text-white/35"}`}
      style={active ? { borderColor: item.accent, backgroundColor: `${item.accent}33` } : undefined}
    >
      <Icon className="size-4 shrink-0" style={{ color: hasData || active ? item.accent : undefined }} aria-hidden="true" />
      {item.label}
      {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-white/50" aria-label="still loading" /> : null}
    </button>
  );
}

function GoogleNav({ tab, data, onSelect }: { tab: TabId; data: GoogleUnpackedData; onSelect: (id: TabId) => void }) {
  const [open, setOpen] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the chosen tab visible in the scrolling row, also when it was picked from the full list.
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !chip) return;
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: "smooth" });
  }, [tab]);

  // A new tab should start at its top, not wherever the previous (longer or shorter) one was scrolled to.
  const barRef = useRef<HTMLDivElement>(null);
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    const container = barRef.current?.parentElement;
    if (!container) return;
    // The dashboard can sit in its own scrolling overlay rather than the page, so find whatever actually scrolls.
    let scroller: HTMLElement | null = container.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const offset = container.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0);
    if (offset >= 0) return;
    if (scroller) scroller.scrollTop += offset;
    else window.scrollBy({ top: offset });
  }, [tab]);

  const select = (id: TabId) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <>
      <nav aria-label="Google Takeout sections" className="hidden lg:sticky lg:top-4 lg:block lg:self-start">
        <NavGroups tab={tab} data={data} onSelect={onSelect} />
      </nav>

      {/* Phones and tablets: a row of tabs that stays at the top while scrolling, plus a button for the full grouped list. */}
      <div ref={barRef} className="sticky top-0 z-30 -mx-4 border-b border-white/10 bg-[#0d0f14]/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
        <div className="flex items-center gap-2">
          <nav aria-label="Google Takeout sections" className="relative min-w-0 flex-1">
            <div ref={chipsRef} className="flex snap-x gap-2 overflow-x-auto pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {NAV_ITEMS.map((item) => (
                <NavChip key={item.id} item={item} active={tab === item.id} hasData={navHasData(item.id, data)} loading={Boolean(TAB_SECTION[item.id] && sectionPending(data, TAB_SECTION[item.id]!))} onSelect={onSelect} />
              ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#0d0f14] to-transparent" aria-hidden="true" />
          </nav>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="true"
            aria-label="All sections"
            className="relative z-20 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-[#15171b] px-3 py-2 text-sm font-semibold text-white"
          >
            <LayoutGrid className="size-4" aria-hidden="true" />
            All
          </button>
        </div>
        {open ? (
          <>
            <button type="button" aria-label="Close menu" tabIndex={-1} className="fixed inset-0 z-10 cursor-default bg-black/40" onClick={() => setOpen(false)} />
            <nav aria-label="All Google Takeout sections" className="absolute left-4 right-4 top-full z-20 mt-2 max-h-[70vh] overflow-y-auto rounded-lg border border-white/10 bg-[#15171b] p-3 shadow-2xl sm:left-6 sm:right-6">
              <NavGroups tab={tab} data={data} onSelect={select} compact />
            </nav>
          </>
        ) : null}
      </div>
    </>
  );
}

export function GoogleDashboard({ data, privacyMode, onPrivacyModeChange, mailBodies, sections }: GoogleDashboardProps) {
  const [tab, setTab] = useState<TabId>("overview");
  return (
    <div className="min-h-screen bg-[#0d0f14] text-white">
      <div className="mx-auto max-w-[88rem] px-4 py-5 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">
              <span>Google Takeout Viewer</span>
              <span>/</span>
              <span>Google Takeout</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-[#34a853]/30 bg-[#34a853]/10 px-2 py-1 text-[#b8f3c9]">
                <ShieldCheck className="size-3" aria-hidden="true" />
                local
              </span>
            </div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-5xl">Google Takeout hub</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
              Indexed {formatNumber(data.summary.entryCount)} files across {formatNumber(data.summary.productCount)} products. My Activity, Chrome History, Gemini, Photos metadata, Play Store, Play Games, Fit, Gmail headers, Drive file sizes, Contacts, Calendar, Pay, Chat, and YouTube history are parsed now; media files and Drive file contents stay unopened, and Gmail message text is read only if you opt in to order totals.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-fit border-white/15 bg-[#15171b] text-white hover:bg-white/10"
            onClick={() => onPrivacyModeChange(!privacyMode)}
          >
            {privacyMode ? <LockKeyhole className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
            {privacyMode ? "Privacy mode on" : "Privacy mode off"}
          </Button>
        </div>

        <BackgroundLoadBar data={data} sections={sections} />

        <div className="mt-3 flex flex-col gap-4 lg:mt-5 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
          <GoogleNav tab={tab} data={data} onSelect={setTab} />
          <div className="min-w-0">
          {tab === "overview" ? <OverviewTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "activity" ? <ActivityTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "chrome" ? <ChromeHistoryTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "gemini" ? <GeminiTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "games" ? <PlayGamesTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "drive" ? <DriveTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "mail" ? <SectionGate sectionKey="mail" data={data} sections={sections}><MailTab data={data} privacyMode={privacyMode} mailBodies={mailBodies} /></SectionGate> : null}
          {tab === "photos" ? <SectionGate sectionKey="photos" data={data} sections={sections}><PhotosTab data={data} privacyMode={privacyMode} /></SectionGate> : null}
          {tab === "play" ? <PlayStoreTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "fit" ? <SectionGate sectionKey="fit" data={data} sections={sections}><FitTab data={data} privacyMode={privacyMode} /></SectionGate> : null}
          {tab === "more" ? <MoreServicesTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "youtube" ? <YouTubeTab data={data} privacyMode={privacyMode} /> : null}
          {tab === "coverage" ? <CoverageTab data={data} privacyMode={privacyMode} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
