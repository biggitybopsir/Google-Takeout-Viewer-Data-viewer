import type { GooglePlayGame, GooglePlayGamesSummary, GoogleParserProgress, GoogleRankedItem } from "@/platforms/google/types";
import { createEntryReader, type GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import { cleanLine, MONTHS, stableId, stripTags } from "@/platforms/google/parser/html";

const GAME_LIMIT = 250;
const ACHIEVEMENT_LIMIT = 80;
const SCORE_LIMIT = 30;
const TOP_LIMIT = 10;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GENERIC_PACKAGE_PARTS = new Set(["client", "app", "android", "mobile", "game", "games", "free", "lite"]);

function takeoutParts(entry: GoogleZipEntry): string[] {
  const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return index >= 0 ? parts.slice(index + 1) : parts;
}

const GAME_FILES = new Set(["activity.html", "achievements.html", "scores.html", "experience.html"]);
const GLOBAL_FILES = new Set(["player.html", "playtime.html", "streaks.html", "followers.html", "following.html"]);

// Recall.html (account-linking tokens), saved-game blobs, and cover images are never read.
export function isPlayGamesFile(entry: GoogleZipEntry): boolean {
  const parts = takeoutParts(entry);
  if (parts[0] !== "Google Play Games Services") return false;
  const name = entry.fileName.toLowerCase();
  if (parts[1] === "Global") return GLOBAL_FILES.has(name);
  return parts[1] === "Games" && parts.length === 4 && GAME_FILES.has(name);
}

function isCloudSaveMetadata(entry: GoogleZipEntry): string | undefined {
  const parts = takeoutParts(entry);
  if (parts[0] !== "Google Play Games Services" || parts[1] !== "Games" || parts.length < 5) return undefined;
  return entry.fileName.toLowerCase() === "metadata.html" ? parts[2] : undefined;
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const chunk of html.split(/<tr[^>]*>/i).slice(1)) {
    const cells = [...chunk.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cleanLine(stripTags(match[1])));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function number(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function columnIndex(header: string[], ...names: string[]): number {
  const lower = header.map((cell) => cell.toLowerCase());
  for (const name of names) {
    const index = lower.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function dateLabelToIso(label: string): string | undefined {
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(label);
  const month = match ? MONTHS[match[2].toLowerCase()] : undefined;
  if (!match || month === undefined) return undefined;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]))).toISOString();
}

function durationSeconds(text: string): number {
  let seconds = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)\s+(hour|minute|second)/gi)) seconds += Number(amount) * { hour: 3600, minute: 60, second: 1 }[unit.toLowerCase() as "hour" | "minute" | "second"];
  return seconds;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function prettyPackage(pkg: string): string {
  const parts = pkg.split(".");
  let last = parts[parts.length - 1] ?? pkg;
  if (GENERIC_PACKAGE_PARTS.has(last.toLowerCase()) && parts.length > 1) last = parts[parts.length - 2];
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ranked(map: Map<string, number>, limit = TOP_LIMIT): GoogleRankedItem[] {
  return [...map.entries()].filter(([, count]) => count > 0).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit);
}

function emptyGame(folder: string): GooglePlayGame {
  return { id: stableId("play-game", folder), title: folder.replace(/_ /g, ": "), unlocked: 0, achievementTotal: 0, xp: 0, scoreCount: 0, cloudSaves: 0, playtimeMinutes: 0, sessions: 0, achievements: [], scores: [] };
}

export async function parsePlayGames(entries: GoogleZipEntry[], progress?: (progress: GoogleParserProgress) => void): Promise<GooglePlayGamesSummary | undefined> {
  const files = entries.filter(isPlayGamesFile);
  if (!files.length) return undefined;
  progress?.({ stage: "parsing", label: "Parsing Play Games", percent: 95 });

  const warnings: string[] = [];
  const games = new Map<string, GooglePlayGame>();
  const gameFor = (folder: string) => {
    let game = games.get(folder);
    if (!game) {
      game = emptyGame(folder);
      games.set(folder, game);
    }
    return game;
  };
  const xpEvents: { ms: number; total: number }[] = [];
  const xpFromEvents = new Map<string, number>();
  let parsedFiles = 0;
  let achievementRows = 0;
  let scoreRows = 0;
  let eventCount = 0;
  let profile: GooglePlayGamesSummary["profile"];
  let followers = 0;
  let following = 0;
  let playtimeHtml: string | undefined;
  let streaksHtml: string | undefined;

  const reader = createEntryReader(files);
  for (const entry of files) {
    const parts = takeoutParts(entry);
    const name = entry.fileName.toLowerCase();
    try {
      const html = await reader.read(entry);
      if (parts[1] === "Global") {
        if (name === "player.html") {
          const rows = tableRows(html);
          const field = new Map(rows.filter((row) => row.length === 2).map((row) => [row[0].toLowerCase(), row[1]] as const));
          const lastGameHeader = rows.findIndex((row) => row[0]?.toLowerCase() === "game");
          const lastGameRow = lastGameHeader >= 0 ? rows[lastGameHeader + 1] : undefined;
          profile = {
            visibility: field.get("player profile visibility is set to"),
            gamerId: field.get("gamer id"),
            level: field.has("experience level") ? number(field.get("experience level")) : undefined,
            xp: field.has("total experience points (xp)") ? number(field.get("total experience points (xp)")) : undefined,
            unlockedFromProfile: field.has("number of unlocked achievements") ? number(field.get("number of unlocked achievements")) : undefined,
            categoryMostXp: field.get("category with most xp"),
            lastLevelledUp: field.get("last levelled up on"),
            lastGame: lastGameRow?.[0],
            lastGameDate: lastGameRow?.[1],
            followers: 0,
            following: 0,
          };
        } else if (name === "playtime.html") playtimeHtml = html;
        else if (name === "streaks.html") streaksHtml = html;
        else if (name === "followers.html") followers = Math.max(0, tableRows(html).length - 1);
        else if (name === "following.html") following = Math.max(0, tableRows(html).length - 1);
      } else {
        const folder = parts[2];
        const game = gameFor(folder);
        const rows = tableRows(html);
        const header = rows[0] ?? [];
        const data = rows.slice(1);
        if (name === "activity.html") {
          const field = new Map(rows.filter((row) => row.length === 2).map((row) => [row[0].toLowerCase(), row[1]] as const));
          game.firstPlayed = field.get("time first played");
          game.lastPlayed = field.get("time last played");
          if (field.has("experience points")) game.xp = number(field.get("experience points"));
          if (field.has("total number of achievements unlocked")) game.unlocked = Math.max(game.unlocked, number(field.get("total number of achievements unlocked")));
        } else if (name === "achievements.html") {
          const nameCol = columnIndex(header, "name");
          const stateCol = columnIndex(header, "state");
          const updatedCol = columnIndex(header, "date last updated");
          const xpCol = columnIndex(header, "experience points");
          game.achievementTotal = data.length;
          achievementRows += data.length;
          game.unlocked = Math.max(game.unlocked, data.filter((row) => (row[stateCol] ?? "").toLowerCase() === "unlocked").length);
          game.achievements = data.slice(0, ACHIEVEMENT_LIMIT).map((row) => ({ name: row[nameCol] ?? "", state: row[stateCol] ?? "", xp: number(row[xpCol]), date: row[updatedCol] || undefined }));
        } else if (name === "scores.html") {
          const boardCol = columnIndex(header, "leaderboard");
          const scoreCol = columnIndex(header, "score");
          const dateCol = columnIndex(header, "score date/time");
          game.scoreCount = data.length;
          scoreRows += data.length;
          game.scores = data.slice(0, SCORE_LIMIT).map((row) => ({ leaderboard: row[boardCol] ?? "", score: row[scoreCol] ?? "", date: row[dateCol] || undefined }));
        } else if (name === "experience.html") {
          const earnedCol = columnIndex(header, "xp earned");
          const totalCol = columnIndex(header, "resulting xp total");
          const dateCol = columnIndex(header, "date created");
          const appCol = columnIndex(header, "originating application");
          eventCount += data.length;
          let earned = 0;
          for (const row of data) {
            earned += number(row[earnedCol]);
            const ms = Date.parse(row[dateCol] ?? "");
            const total = number(row[totalCol]);
            if (!Number.isNaN(ms) && total > 0) xpEvents.push({ ms, total });
            const title = row[appCol];
            if (title && game.title === folder.replace(/_ /g, ": ")) game.title = title;
          }
          xpFromEvents.set(folder, earned);
        }
      }
      parsedFiles += 1;
    } catch (error) {
      entry.status = "malformed";
      entry.reason = "Could not parse this Play Games file";
      warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "Could not parse this Play Games file."}`);
    }
  }
  if (!parsedFiles && !warnings.length) return undefined;

  for (const [folder, earned] of xpFromEvents) {
    const game = games.get(folder);
    if (game && !game.xp) game.xp = earned;
  }
  for (const entry of entries) {
    const folder = isCloudSaveMetadata(entry);
    if (folder) gameFor(folder).cloudSaves += 1;
  }
  if (profile) profile = { ...profile, followers, following };

  // Playtime is keyed by Android package name, so match it to a game title by its last segment where possible.
  const titleKeys = new Map<string, GooglePlayGame>();
  for (const game of games.values()) titleKeys.set(normalize(game.title), game);
  const titleForPackage = (pkg: string): { title: string; game?: GooglePlayGame } => {
    const segments = pkg.split(".");
    const match = titleKeys.get(normalize(segments[segments.length - 1] ?? "")) ?? titleKeys.get(normalize(segments.slice(-2).join("")));
    return match ? { title: match.title, game: match } : { title: prettyPackage(pkg) };
  };

  let playtime: GooglePlayGamesSummary["playtime"];
  if (playtimeHtml) {
    const token = /<tr><td valign="top">(\d+\s+\w+\s+\d{4})<\/td>|<tr><td>([^<]+)<\/td><td>([^<]+)<\/td><td>[^<]*<\/td><td>[^<]*<\/td><td>(\d+)<\/td><\/tr>/gi;
    const byGame = new Map<string, number>();
    const byMonth = new Map<string, number>();
    const byWeekday = new Map<string, number>();
    const byDay = new Map<string, number>();
    const packages = new Set<string>();
    let current: string | undefined;
    let totalSeconds = 0;
    let sessions = 0;
    for (const match of playtimeHtml.matchAll(token)) {
      if (match[1]) {
        current = dateLabelToIso(match[1]);
        continue;
      }
      if (!current) continue;
      const seconds = durationSeconds(match[3]);
      const count = Number(match[4]);
      const target = titleForPackage(match[2]);
      packages.add(match[2]);
      totalSeconds += seconds;
      sessions += count;
      byGame.set(target.title, (byGame.get(target.title) ?? 0) + seconds / 60);
      if (target.game) {
        target.game.playtimeMinutes += seconds / 60;
        target.game.sessions += count;
      }
      byMonth.set(current.slice(0, 7), (byMonth.get(current.slice(0, 7)) ?? 0) + seconds / 60);
      const weekday = WEEKDAYS[new Date(current).getUTCDay()];
      byWeekday.set(weekday, (byWeekday.get(weekday) ?? 0) + seconds / 60);
      byDay.set(current.slice(0, 10), (byDay.get(current.slice(0, 10)) ?? 0) + seconds / 60);
    }
    if (byDay.size) {
      const days = [...byDay.keys()].sort();
      const longest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
      playtime = {
        totalMinutes: Math.round(totalSeconds / 60),
        sessions,
        activeDays: byDay.size,
        packages: packages.size,
        dateRange: { start: `${days[0]}T00:00:00.000Z`, end: `${days[days.length - 1]}T00:00:00.000Z` },
        byMonth: [...byMonth.entries()].map(([label, count]) => ({ label, count: Math.round(count) })).sort((a, b) => a.label.localeCompare(b.label)),
        byWeekday: WEEKDAYS.map((label) => ({ label, count: Math.round(byWeekday.get(label) ?? 0) })),
        byGame: ranked(new Map([...byGame.entries()].map(([label, count]) => [label, Math.round(count)]))),
        longestDay: { date: longest[0], minutes: Math.round(longest[1]) },
      };
    }
  }

  let streaks: GooglePlayGamesSummary["streaks"];
  if (streaksHtml) {
    const text = stripTags(streaksHtml);
    const mostPlayed = new Map<string, number>();
    const dates: string[] = [];
    for (const match of streaksHtml.matchAll(/<tr><td>(\d+\s+\w+\s+\d{4})<\/td><td>([^<]+)<\/td><\/tr>/gi)) {
      const iso = dateLabelToIso(match[1]);
      if (iso) dates.push(iso);
      const title = titleForPackage(match[2].trim()).title;
      mostPlayed.set(title, (mostPlayed.get(title) ?? 0) + 1);
    }
    dates.sort();
    streaks = {
      longest: Number(/Longest Streak:\s*(\d+)/i.exec(text)?.[1] ?? 0),
      current: Number(/Current Streak:\s*(\d+)/i.exec(text)?.[1] ?? 0),
      days: dates.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      mostPlayed: ranked(mostPlayed, 6),
    };
  }

  // XP totals are account-wide, so the last (largest) total seen in each month traces progress over time.
  const monthlyXp = new Map<string, number>();
  for (const event of xpEvents) {
    const month = new Date(event.ms).toISOString().slice(0, 7);
    monthlyXp.set(month, Math.max(monthlyXp.get(month) ?? 0, event.total));
  }
  const xpTimeline = [...monthlyXp.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));

  const gameList = [...games.values()].map((game) => ({ ...game, playtimeMinutes: Math.round(game.playtimeMinutes) })).sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? "") || a.title.localeCompare(b.title));
  const unlockedTotal = gameList.reduce((sum, game) => sum + game.unlocked, 0);
  const byUnlocked = new Map(gameList.filter((game) => game.unlocked).map((game) => [game.title, game.unlocked]));
  const byXp = new Map(gameList.filter((game) => game.xp).map((game) => [game.title, game.xp]));

  return {
    games: gameList.length,
    gamesWithAchievements: gameList.filter((game) => game.achievementTotal).length,
    unlockedAchievements: profile?.unlockedFromProfile ?? unlockedTotal,
    achievementRows,
    scoreRows,
    xpEvents: eventCount,
    cloudSaves: gameList.reduce((sum, game) => sum + game.cloudSaves, 0),
    parsedFiles,
    warnings,
    profile,
    playtime,
    streaks,
    xpTimeline,
    topByAchievements: ranked(byUnlocked),
    topByXp: ranked(byXp),
    gameList: gameList.slice(0, GAME_LIMIT),
    gameLimit: GAME_LIMIT,
    isGameListCapped: gameList.length > GAME_LIMIT,
  };
}
