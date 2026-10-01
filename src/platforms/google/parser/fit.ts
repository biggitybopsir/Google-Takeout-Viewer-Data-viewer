import type { GoogleFitDay, GoogleFitPeriod, GoogleFitSummary, GoogleParserProgress, GoogleRankedItem } from "@/platforms/google/types";
import { createEntryReader, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import { parseCsv } from "@/platforms/google/parser/small-services";

const STEP_GOAL = 5_000;
const TOP_DAY_LIMIT = 10;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function takeoutParts(entry: GoogleZipEntry): string[] {
  const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return index >= 0 ? parts.slice(index + 1) : parts;
}

// Only the "Daily activity metrics" CSVs are read. The "All data" JSON files hold the same steps as raw data points,
// so reading both would double-count; they stay in Coverage as indexed.
export function isFitFile(entry: GoogleZipEntry): boolean {
  return entry.product === "Fit" && entry.fileName.toLowerCase().endsWith(".csv") && takeoutParts(entry).includes("Daily activity metrics");
}

function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyDay(date: string): GoogleFitDay {
  return { date, steps: 0, distanceM: 0, moveMinutes: 0, heartPoints: 0, calories: 0 };
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dateFromNumber(value: number): string {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function isActive(day: GoogleFitDay): boolean {
  return day.steps > 0 || day.moveMinutes > 0 || day.distanceM > 0;
}

function columnIndexes(header: string[]) {
  const lower = header.map((cell) => cell.trim().toLowerCase());
  const find = (name: string) => lower.indexOf(name);
  return {
    date: find("date"),
    start: find("start time"),
    moveMinutes: find("move minutes count"),
    calories: find("calories (kcal)"),
    distance: find("distance (m)"),
    heartPoints: find("heart points"),
    steps: find("step count"),
  };
}

function toPeriods(days: GoogleFitDay[], keyLength: number): GoogleFitPeriod[] {
  const periods = new Map<string, GoogleFitPeriod>();
  for (const day of days) {
    if (!isActive(day)) continue;
    const label = day.date.slice(0, keyLength);
    const period = periods.get(label) ?? { label, steps: 0, distanceKm: 0, moveMinutes: 0, heartPoints: 0, activeDays: 0 };
    period.steps += day.steps;
    period.distanceKm += day.distanceM / 1000;
    period.moveMinutes += day.moveMinutes;
    period.heartPoints += day.heartPoints;
    period.activeDays += 1;
    periods.set(label, period);
  }
  return [...periods.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((period) => ({ ...period, distanceKm: Math.round(period.distanceKm * 10) / 10 }));
}

export async function parseFit(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void): Promise<GoogleFitSummary | undefined> {
  const files = entries.filter(isFitFile);
  if (!files.length) return undefined;
  progress?.({ stage: "parsing", label: "Parsing Google Fit daily activity", percent: 93 });

  const warnings: string[] = [];
  let parsedFiles = 0;
  let malformedFiles = 0;
  const aggregateDays = new Map<string, GoogleFitDay>();
  const intervalDays = new Map<string, GoogleFitDay>();
  const hourSteps = new Array<number>(24).fill(0);

  const markMalformed = (entry: GoogleZipEntry, reason: string, detail?: string) => {
    entry.status = "malformed";
    entry.reason = reason;
    malformedFiles += 1;
    warnings.push(`${entry.path}: ${detail ?? reason}`);
  };

  const reader = createEntryReader(files);
  for (const entry of files) {
    let text: string;
    try {
      text = await reader.read(entry);
    } catch (error) {
      markMalformed(entry, "Could not read file", error instanceof Error ? error.message : undefined);
      continue;
    }
    const rows = parseCsv(text);
    const header = rows[0];
    if (!header) {
      markMalformed(entry, "Empty CSV");
      continue;
    }
    const columns = columnIndexes(header);
    const isAggregate = columns.date >= 0;
    const isIntervals = columns.start >= 0;
    if (!isAggregate && !isIntervals) {
      markMalformed(entry, "Unrecognized Fit CSV header");
      continue;
    }

    if (isAggregate) {
      for (const row of rows.slice(1)) {
        const date = (row[columns.date] ?? "").trim();
        if (!DATE_PATTERN.test(date)) continue;
        aggregateDays.set(date, {
          date,
          steps: Math.round(toNumber(row[columns.steps])),
          distanceM: toNumber(row[columns.distance]),
          moveMinutes: toNumber(row[columns.moveMinutes]),
          heartPoints: toNumber(row[columns.heartPoints]),
          calories: toNumber(row[columns.calories]),
        });
      }
    } else {
      const date = entry.fileName.replace(/\.csv$/i, "");
      if (!DATE_PATTERN.test(date)) {
        markMalformed(entry, "Interval file name is not a date");
        continue;
      }
      const day = intervalDays.get(date) ?? emptyDay(date);
      for (const row of rows.slice(1)) {
        const steps = Math.round(toNumber(row[columns.steps]));
        day.steps += steps;
        day.distanceM += toNumber(row[columns.distance]);
        day.moveMinutes += toNumber(row[columns.moveMinutes]);
        day.heartPoints += toNumber(row[columns.heartPoints]);
        day.calories += toNumber(row[columns.calories]);
        const hour = Number((row[columns.start] ?? "").slice(0, 2));
        if (steps > 0 && Number.isInteger(hour) && hour >= 0 && hour < 24) hourSteps[hour] += steps;
      }
      intervalDays.set(date, day);
    }
    parsedFiles += 1;
  }

  if (!parsedFiles) return { ...emptySummary(), parsedFiles, malformedFiles, warnings, rawDataFiles: rawDataFileCount(entries) };

  const dailySource = aggregateDays.size ? "aggregate" : "intervals";
  const days = [...(dailySource === "aggregate" ? aggregateDays : intervalDays).values()].sort((a, b) => a.date.localeCompare(b.date));
  const activeList = days.filter(isActive);

  const totalSteps = days.reduce((sum, day) => sum + day.steps, 0);
  const stepDays = days.filter((day) => day.steps > 0);
  const weekdayTotals = new Array<number>(7).fill(0);
  const weekdayDays = new Array<number>(7).fill(0);
  for (const day of stepDays) {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    weekdayTotals[weekday] += day.steps;
    weekdayDays[weekday] += 1;
  }
  const byWeekday: GoogleRankedItem[] = WEEKDAYS.map((label, index) => ({ label, count: weekdayDays[index] ? Math.round(weekdayTotals[index] / weekdayDays[index]) : 0 }));
  const byHour: GoogleRankedItem[] = hourSteps.map((count, hour) => ({ label: String(hour).padStart(2, "0"), count }));

  // Longest run of consecutive calendar days at or above the step goal.
  let goalStreak: GoogleFitSummary["goalStreak"];
  let run = 0;
  let runStart = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const day of days) {
    if (day.steps < STEP_GOAL) continue;
    const number = dayNumber(day.date);
    if (number === previous + 1) run += 1;
    else {
      run = 1;
      runStart = number;
    }
    previous = number;
    if (!goalStreak || run > goalStreak.days) goalStreak = { days: run, startDate: dateFromNumber(runStart), endDate: dateFromNumber(number) };
  }

  // Calendar days between the first and last active day with no activity recorded.
  let untrackedDays = 0;
  let longestGap: GoogleFitSummary["longestGap"];
  for (let index = 1; index < activeList.length; index += 1) {
    const gap = dayNumber(activeList[index].date) - dayNumber(activeList[index - 1].date) - 1;
    if (gap <= 0) continue;
    untrackedDays += gap;
    if (!longestGap || gap > longestGap.days) {
      longestGap = { days: gap, startDate: dateFromNumber(dayNumber(activeList[index - 1].date) + 1), endDate: dateFromNumber(dayNumber(activeList[index].date) - 1) };
    }
  }

  const bestDay = stepDays.reduce<GoogleFitDay | undefined>((best, day) => (!best || day.steps > best.steps ? day : best), undefined);
  const first = activeList[0]?.date;
  const last = activeList[activeList.length - 1]?.date;

  return {
    parsedFiles,
    malformedFiles,
    warnings,
    totalDays: days.length,
    activeDays: activeList.length,
    dateRange: first && last ? { start: first, end: last } : undefined,
    totalSteps,
    totalDistanceKm: Math.round((days.reduce((sum, day) => sum + day.distanceM, 0) / 1000) * 10) / 10,
    totalMoveMinutes: days.reduce((sum, day) => sum + day.moveMinutes, 0),
    totalHeartPoints: days.reduce((sum, day) => sum + day.heartPoints, 0),
    totalCalories: Math.round(days.reduce((sum, day) => sum + day.calories, 0)),
    averageStepsPerActiveDay: stepDays.length ? Math.round(totalSteps / stepDays.length) : 0,
    stepGoal: STEP_GOAL,
    goalDays: days.filter((day) => day.steps >= STEP_GOAL).length,
    tenKDays: days.filter((day) => day.steps >= 10_000).length,
    goalStreak,
    bestDay,
    untrackedDays,
    longestGap,
    lastTrackedDate: last,
    byYear: toPeriods(days, 4),
    byMonth: toPeriods(days, 7),
    byWeekday,
    byHour,
    topDays: [...stepDays].sort((a, b) => b.steps - a.steps || b.date.localeCompare(a.date)).slice(0, TOP_DAY_LIMIT),
    dailySource,
    rawDataFiles: rawDataFileCount(entries),
  };
}

function rawDataFileCount(entries: GoogleZipEntry[]): number {
  return entries.filter((entry) => entry.product === "Fit" && !isFitFile(entry)).length;
}

function emptySummary(): GoogleFitSummary {
  return {
    parsedFiles: 0,
    malformedFiles: 0,
    warnings: [],
    totalDays: 0,
    activeDays: 0,
    totalSteps: 0,
    totalDistanceKm: 0,
    totalMoveMinutes: 0,
    totalHeartPoints: 0,
    totalCalories: 0,
    averageStepsPerActiveDay: 0,
    stepGoal: STEP_GOAL,
    goalDays: 0,
    tenKDays: 0,
    untrackedDays: 0,
    byYear: [],
    byMonth: [],
    byWeekday: WEEKDAYS.map((label) => ({ label, count: 0 })),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0"), count: 0 })),
    topDays: [],
    dailySource: "aggregate",
    rawDataFiles: 0,
  };
}
