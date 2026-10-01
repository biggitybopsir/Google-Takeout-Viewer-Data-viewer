import type { GoogleDayCount, GoogleUnpackedData } from "@/platforms/google/types";

export type GoogleRecapSourceKey = "activity" | "chrome" | "youtube" | "mail" | "photos" | "gemini";

export type GoogleRecapSource = {
  key: GoogleRecapSourceKey;
  label: string;
  /** What one count means for this source, shown next to its total. */
  unit: string;
  color: string;
  total: number;
  activeDays: number;
  firstDate: string;
  lastDate: string;
};

export type GoogleRecapDay = {
  date: string;
  total: number;
  /** How many sources had at least one item on this day. */
  services: number;
  counts: Partial<Record<GoogleRecapSourceKey, number>>;
};

export type GoogleRecap = {
  sources: GoogleRecapSource[];
  /** Only days with at least one item, oldest first. */
  days: GoogleRecapDay[];
  firstDate: string;
  lastDate: string;
  spanDays: number;
  busiest: GoogleRecapDay;
  mostServices: GoogleRecapDay;
  longestStreak: { days: number; startDate: string; endDate: string };
  years: { year: string; activeDays: number; total: number }[];
  /** Month labels (YYYY-MM) from the first to the last month, and each source's count in every one of them. */
  months: string[];
  monthlyBySource: Record<string, number[]>;
};

const SOURCE_STYLE: Record<GoogleRecapSourceKey, { label: string; unit: string; color: string }> = {
  activity: { label: "Search, Maps and other activity", unit: "activity entries", color: "#4285f4" },
  chrome: { label: "Chrome", unit: "page visits", color: "#34a853" },
  youtube: { label: "YouTube", unit: "watches and searches", color: "#ea4335" },
  mail: { label: "Gmail", unit: "messages", color: "#f28b82" },
  photos: { label: "Photos", unit: "photos and videos taken", color: "#fbbc04" },
  gemini: { label: "Gemini", unit: "prompts", color: "#a142f4" },
};

const DAY_MS = 86_400_000;

function toMap(items: GoogleDayCount[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items ?? []) if (/^\d{4}-\d{2}-\d{2}$/.test(item.date)) map.set(item.date, (map.get(item.date) ?? 0) + item.count);
  return map;
}

// Chrome's own history file is the fuller record for the year it covers; My Activity's Chrome rows fill in the days before it.
function chromeSeries(data: GoogleUnpackedData): Map<string, number> {
  const fromActivity = toMap(data.activity?.daily.chrome);
  const history = data.chromeHistory;
  if (!history?.daily.length) return fromActivity;
  const fromHistory = toMap(history.daily);
  const days = [...fromHistory.keys()].sort();
  const first = days[0];
  const last = days[days.length - 1];
  const merged = new Map(fromHistory);
  for (const [date, count] of fromActivity) if (date < first || date > last) merged.set(date, count);
  return merged;
}

function dayNumber(date: string): number {
  return Math.round(new Date(`${date}T00:00:00Z`).getTime() / DAY_MS);
}

export function buildGoogleRecap(data: GoogleUnpackedData): GoogleRecap | undefined {
  const series: [GoogleRecapSourceKey, Map<string, number>][] = [
    ["activity", toMap(data.activity?.daily.other)],
    ["chrome", chromeSeries(data)],
    ["youtube", toMap(data.activity?.daily.youtube)],
    ["mail", toMap(data.mail?.daily)],
    ["photos", toMap(data.photos?.daily)],
    ["gemini", toMap(data.gemini?.daily)],
  ];
  const present = series.filter(([, map]) => map.size > 0);
  if (!present.length) return undefined;

  const dayMap = new Map<string, GoogleRecapDay>();
  const sources: GoogleRecapSource[] = [];
  for (const [key, map] of present) {
    const dates = [...map.keys()].sort();
    let total = 0;
    for (const [date, count] of map) {
      total += count;
      const day = dayMap.get(date) ?? { date, total: 0, services: 0, counts: {} };
      day.total += count;
      day.services += 1;
      day.counts[key] = count;
      dayMap.set(date, day);
    }
    sources.push({ key, ...SOURCE_STYLE[key], total, activeDays: map.size, firstDate: dates[0], lastDate: dates[dates.length - 1] });
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = days[0].date;
  const lastDate = days[days.length - 1].date;
  const busiest = days.reduce((best, day) => (day.total > best.total ? day : best), days[0]);
  const mostServices = days.reduce((best, day) => (day.services > best.services || (day.services === best.services && day.total > best.total) ? day : best), days[0]);

  let streak = { days: 1, startDate: days[0].date, endDate: days[0].date };
  let run = { days: 1, startDate: days[0].date };
  for (let index = 1; index < days.length; index += 1) {
    run = dayNumber(days[index].date) - dayNumber(days[index - 1].date) === 1 ? { days: run.days + 1, startDate: run.startDate } : { days: 1, startDate: days[index].date };
    if (run.days > streak.days) streak = { days: run.days, startDate: run.startDate, endDate: days[index].date };
  }

  const years = new Map<string, { activeDays: number; total: number }>();
  for (const day of days) {
    const year = years.get(day.date.slice(0, 4)) ?? { activeDays: 0, total: 0 };
    year.activeDays += 1;
    year.total += day.total;
    years.set(day.date.slice(0, 4), year);
  }

  const months: string[] = [];
  let [year, month] = firstDate.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = lastDate.slice(0, 7).split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const monthIndex = new Map(months.map((label, index) => [label, index]));
  const monthlyBySource: Record<string, number[]> = {};
  for (const [key, map] of present) {
    const counts = new Array<number>(months.length).fill(0);
    for (const [date, count] of map) counts[monthIndex.get(date.slice(0, 7)) ?? 0] += count;
    monthlyBySource[key] = counts;
  }

  return {
    sources,
    days,
    firstDate,
    lastDate,
    spanDays: dayNumber(lastDate) - dayNumber(firstDate) + 1,
    busiest,
    mostServices,
    longestStreak: streak,
    years: [...years.entries()].map(([label, value]) => ({ year: label, ...value })).sort((a, b) => a.year.localeCompare(b.year)),
    months,
    monthlyBySource,
  };
}
