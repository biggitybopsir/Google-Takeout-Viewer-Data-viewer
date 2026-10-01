import { buildSpend, type SpendOrder } from "@/platforms/google/parser/mail-spend";
import type { GoogleDayCount, GoogleDriveFile, GoogleDriveSummary, GoogleFitDay, GoogleFitPeriod, GoogleFitSummary, GoogleGeminiConversation, GoogleGeminiSummary, GooglePlayGame, GooglePlayGamesSummary, GoogleMailDomain, GoogleMailSender, GoogleMailSpend, GoogleMailSummary, GoogleUnpackedData } from "@/platforms/google/types";

// Deterministic made-up daily counts (no real activity). A day is active with probability `chance`, busy days follow a slow wave, and the counts are scaled to add up to `total` so the recap agrees with the tab it summarises.
function demoDaily(start: string, end: string, total: number, chance: number, salt: number): GoogleDayCount[] {
  const days: { date: string; weight: number }[] = [];
  const last = new Date(`${end}T00:00:00Z`).getTime();
  for (let time = new Date(`${start}T00:00:00Z`).getTime(), index = 0; time <= last; time += 86_400_000, index += 1) {
    const noise = Math.abs(Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453) % 1;
    if (noise > chance) continue;
    const wave = 0.6 + 0.4 * Math.sin(index / 37 + salt);
    const weekend = new Date(time).getUTCDay() % 6 === 0 ? 1.3 : 1;
    days.push({ date: new Date(time).toISOString().slice(0, 10), weight: wave * weekend * (0.3 + noise * 1.4) });
  }
  const weightSum = days.reduce((sum, day) => sum + day.weight, 0) || 1;
  return days.map((day) => ({ date: day.date, count: Math.max(1, Math.round((day.weight / weightSum) * total)) }));
}

// Synthetic, deterministic steps so the Fit tab has something to draw without any real health data.
function buildFitDemo(): GoogleFitSummary {
  const days: GoogleFitDay[] = [];
  for (let offset = 0; offset < 240; offset += 1) {
    if (offset % 17 === 5 || offset % 17 === 6) continue;
    const date = new Date(Date.UTC(2023, 0, 1 + offset)).toISOString().slice(0, 10);
    const steps = 2_200 + ((offset * 2_371) % 9_400);
    days.push({ date, steps, distanceM: Math.round(steps * 0.74), moveMinutes: Math.round(steps / 95), heartPoints: offset % 4 === 0 ? 6 : 0, calories: 0 });
  }
  const periodOf = (keyLength: number): GoogleFitPeriod[] => {
    const periods = new Map<string, GoogleFitPeriod>();
    for (const day of days) {
      const label = day.date.slice(0, keyLength);
      const period = periods.get(label) ?? { label, steps: 0, distanceKm: 0, moveMinutes: 0, heartPoints: 0, activeDays: 0 };
      period.steps += day.steps;
      period.distanceKm += day.distanceM / 1000;
      period.moveMinutes += day.moveMinutes;
      period.heartPoints += day.heartPoints;
      period.activeDays += 1;
      periods.set(label, period);
    }
    return [...periods.values()].map((period) => ({ ...period, distanceKm: Math.round(period.distanceKm * 10) / 10 }));
  };
  const totalSteps = days.reduce((sum, day) => sum + day.steps, 0);
  const sorted = [...days].sort((a, b) => b.steps - a.steps);
  return {
    parsedFiles: 1,
    malformedFiles: 0,
    warnings: [],
    totalDays: days.length,
    activeDays: days.length,
    dateRange: { start: days[0].date, end: days[days.length - 1].date },
    totalSteps,
    totalDistanceKm: Math.round(days.reduce((sum, day) => sum + day.distanceM, 0) / 100) / 10,
    totalMoveMinutes: days.reduce((sum, day) => sum + day.moveMinutes, 0),
    totalHeartPoints: days.reduce((sum, day) => sum + day.heartPoints, 0),
    totalCalories: 0,
    averageStepsPerActiveDay: Math.round(totalSteps / days.length),
    stepGoal: 5_000,
    goalDays: days.filter((day) => day.steps >= 5_000).length,
    tenKDays: days.filter((day) => day.steps >= 10_000).length,
    goalStreak: { days: 4, startDate: days[40].date, endDate: days[43].date },
    bestDay: sorted[0],
    untrackedDays: 30,
    longestGap: { days: 2, startDate: days[4].date, endDate: days[5].date },
    lastTrackedDate: days[days.length - 1].date,
    byYear: periodOf(4),
    byMonth: periodOf(7),
    byWeekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ label, count: 5_200 + index * 310 })),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0"), count: hour < 6 ? 400 : hour >= 22 ? 900 : 12_000 + Math.round(Math.sin((hour - 6) / 3) * 9_000) })),
    topDays: sorted.slice(0, 10),
    dailySource: "aggregate",
    rawDataFiles: 15,
  };
}

// Made-up file names and sizes so the Drive tab can be shown without anyone's real account. Every total is derived from the list.
function buildDriveDemo(): GoogleDriveSummary {
  const categoryLabels: Record<string, string> = { archives: "Archives", video: "Video", documents: "Documents", spreadsheets: "Spreadsheets", other: "Other" };
  const categoryOf: Record<string, string> = { ".zip": "archives", ".7z": "archives", ".mp4": "video", ".pdf": "documents", ".docx": "documents", ".txt": "documents", ".xlsx": "spreadsheets" };
  const file = (path: string, bytes: number, modified: string): GoogleDriveFile => {
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "(none)";
    const category = categoryOf[extension] ?? "other";
    return { path, name, folder: parts.slice(0, -1).join("/"), extension, category, bytes, modified, archive: category === "archives" };
  };
  const largestFiles = [
    file("Backups/project-snapshot.zip", 1_240_000_000, "2026-08-30"),
    file("Holiday/trip-photos.7z", 640_000_000, "2026-06-12"),
    file("Videos/school-project.mp4", 150_000_000, "2022-11-04"),
    file("Videos/birthday.mp4", 62_000_000, "2025-05-18"),
    file("Backups/old-site.zip", 41_000_000, "2024-02-09"),
    file("Documents/thesis-draft.docx", 2_400_000, "2024-04-21"),
    file("Documents/thesis-final.docx", 2_300_000, "2024-05-02"),
    file("Documents/cv.pdf", 410_000, "2024-10-01"),
    file("Budget/expenses-june.bak", 237_000, "2026-06-18"),
    file("Budget/expenses-july.bak", 237_000, "2026-07-05"),
    file("Documents/budget.xlsx", 64_000, "2025-01-14"),
    file("Documents/cover-letter.docx", 38_000, "2024-10-01"),
    file("notes.txt", 2_000, "2020-06-14"),
    file("wifi.txt", 12, "2020-06-05"),
  ];
  const tally = (keyOf: (item: GoogleDriveFile) => string) => {
    const map = new Map<string, { files: number; bytes: number }>();
    for (const item of largestFiles) {
      const entry = map.get(keyOf(item)) ?? { files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += item.bytes;
      map.set(keyOf(item), entry);
    }
    return [...map.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.bytes - a.bytes);
  };
  const years = new Map<string, number>();
  for (const item of largestFiles) years.set(item.modified!.slice(0, 4), (years.get(item.modified!.slice(0, 4)) ?? 0) + 1);
  const archives = largestFiles.filter((item) => item.archive);
  return {
    files: largestFiles.length,
    folders: 5,
    totalBytes: largestFiles.reduce((sum, item) => sum + item.bytes, 0),
    dateRange: { start: "2020-06-05", end: "2026-08-30" },
    byCategory: tally((item) => item.category).map((item) => ({ key: item.key, label: categoryLabels[item.key], files: item.files, bytes: item.bytes })),
    byType: tally((item) => item.extension).map((item) => ({ extension: item.key, files: item.files, bytes: item.bytes })),
    byYear: [...years.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label)),
    byFolder: tally((item) => item.folder.split("/")[0]).map((item) => ({ path: item.key, files: item.files, bytes: item.bytes })),
    archives: { files: archives.length, bytes: archives.reduce((sum, item) => sum + item.bytes, 0) },
    largestFiles,
    largestLimit: 100,
    isLargestCapped: false,
  };
}

// Made-up games and numbers so the Play Games tab can be shown without anyone's real account.
function buildPlayGamesDemo(): GooglePlayGamesSummary {
  const game = (id: string, title: string, extra: Partial<GooglePlayGame>): GooglePlayGame => ({
    id,
    title,
    unlocked: 0,
    achievementTotal: 0,
    xp: 0,
    scoreCount: 0,
    cloudSaves: 0,
    playtimeMinutes: 0,
    sessions: 0,
    achievements: [],
    scores: [],
    ...extra,
  });
  const gameList: GooglePlayGame[] = [
    game("g1", "Example Kingdoms", {
      firstPlayed: "2024-08-26T07:00:00.000Z",
      lastPlayed: "2026-09-19T00:44:38.000Z",
      unlocked: 3,
      achievementTotal: 5,
      xp: 12_500,
      playtimeMinutes: 6_480,
      sessions: 410,
      cloudSaves: 1,
      achievements: [
        { name: "First Castle", state: "Unlocked", xp: 1_000, date: "2024-09-01T10:00:00.000Z" },
        { name: "Hundred Wins", state: "Unlocked", xp: 5_000, date: "2025-03-12T18:20:00.000Z" },
        { name: "Master Builder", state: "Unlocked", xp: 2_500, date: "2026-02-02T09:15:00.000Z" },
        { name: "Legend", state: "Revealed", xp: 0 },
        { name: "Secret Hero", state: "Hidden", xp: 0 },
      ],
    }),
    game("g2", "Example Racer", {
      firstPlayed: "2019-05-10T12:00:00.000Z",
      lastPlayed: "2023-01-08T21:30:00.000Z",
      unlocked: 2,
      achievementTotal: 4,
      xp: 3_000,
      scoreCount: 2,
      achievements: [
        { name: "Pole Position", state: "Unlocked", xp: 1_000, date: "2019-05-11T12:00:00.000Z" },
        { name: "Clean Lap", state: "Unlocked", xp: 2_000, date: "2019-06-01T12:00:00.000Z" },
        { name: "Night Driver", state: "Revealed", xp: 0 },
        { name: "Champion", state: "Hidden", xp: 0 },
      ],
      scores: [
        { leaderboard: "Best lap", score: "8421", date: "2019-06-02T12:00:00.000Z" },
        { leaderboard: "Win streak", score: "7", date: "2019-06-05T12:00:00.000Z" },
      ],
    }),
    game("g3", "Example Puzzle", { firstPlayed: "2021-03-02T08:00:00.000Z", lastPlayed: "2021-03-30T08:00:00.000Z" }),
  ];
  return {
    games: 12,
    gamesWithAchievements: 2,
    unlockedAchievements: 5,
    achievementRows: 9,
    scoreRows: 2,
    xpEvents: 5,
    cloudSaves: 1,
    parsedFiles: 14,
    warnings: [],
    profile: { visibility: "Public", gamerId: "ExamplePlayer", level: 12, xp: 15_500, unlockedFromProfile: 5, categoryMostXp: "Strategy", lastLevelledUp: "2026-04-29T17:09:23.000Z", lastGame: "Example Kingdoms", lastGameDate: "2026-09-19T00:44:38.000Z", followers: 0, following: 0 },
    playtime: {
      totalMinutes: 6_900,
      sessions: 440,
      activeDays: 210,
      packages: 3,
      dateRange: { start: "2024-08-26T00:00:00.000Z", end: "2026-09-16T00:00:00.000Z" },
      byMonth: [
        { label: "2024-08", count: 120 },
        { label: "2024-11", count: 840 },
        { label: "2025-03", count: 300 },
        { label: "2026-03", count: 1_100 },
        { label: "2026-07", count: 1_300 },
        { label: "2026-08", count: 1_950 },
        { label: "2026-09", count: 790 },
      ],
      byWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ label, count: 700 + index * 60 })),
      byGame: [
        { label: "Example Kingdoms", count: 6_480 },
        { label: "Example Blocks", count: 360 },
        { label: "Example Puzzle", count: 60 },
      ],
      longestDay: { date: "2026-08-01", minutes: 390 },
    },
    streaks: { longest: 69, current: 1, days: 143, firstDate: "2026-03-20T00:00:00.000Z", lastDate: "2026-09-16T00:00:00.000Z", mostPlayed: [{ label: "Example Kingdoms", count: 142 }, { label: "Example Blocks", count: 1 }] },
    xpTimeline: [
      { label: "2019-05", count: 4_000 },
      { label: "2021-03", count: 7_500 },
      { label: "2024-09", count: 9_000 },
      { label: "2025-03", count: 12_000 },
      { label: "2026-02", count: 15_500 },
    ],
    topByAchievements: [{ label: "Example Kingdoms", count: 3 }, { label: "Example Racer", count: 2 }],
    topByXp: [{ label: "Example Kingdoms", count: 12_500 }, { label: "Example Racer", count: 3_000 }],
    gameList,
    gameLimit: 250,
    isGameListCapped: false,
  };
}

// Made-up prompts and replies so the Gemini tab can be shown without anyone's real conversations.
function buildGeminiDemo(): GoogleGeminiSummary {
  const exchange = (id: string, time: string, prompt: string, response: string | undefined, extra: { images?: number; attachments?: string[] } = {}) => ({
    id,
    time,
    prompt,
    response,
    promptChars: prompt.length,
    responseChars: response?.length ?? 0,
    images: extra.images ?? 0,
    attachments: extra.attachments ?? [],
    truncated: false,
  });
  const conversations: GoogleGeminiConversation[] = [
    {
      id: "demo-c1",
      firstTime: "2026-08-22T20:40:00.000Z",
      lastTime: "2026-08-22T20:44:00.000Z",
      images: 1,
      attachmentCount: 0,
      exchanges: [
        exchange("g1", "2026-08-22T20:40:00.000Z", "Describe a cover for a fantasy novel set in a floating city.", "Picture a city of pale stone drifting above a sea of clouds, with lanterns along the bridges.\n\n- Warm gold light against a deep blue sky\n- One small figure on the highest tower"),
        exchange("g2", "2026-08-22T20:44:00.000Z", "Make an illustration of that.", "Here is the illustration.", { images: 1 }),
      ],
    },
    {
      id: "demo-c2",
      firstTime: "2026-03-09T09:10:00.000Z",
      lastTime: "2026-03-09T09:25:00.000Z",
      images: 0,
      attachmentCount: 2,
      exchanges: [
        exchange("g3", "2026-03-09T09:10:00.000Z", "Why does my script print the list twice? I attached it.", "The loop runs once per file and the print sits outside it, so the final list prints again.", { attachments: ["example_script.py", "notes.txt"] }),
        exchange("g4", "2026-03-09T09:25:00.000Z", "Thanks, that fixed it.", "Glad it worked."),
      ],
    },
    {
      id: "demo-c3",
      firstTime: "2026-01-06T18:00:00.000Z",
      lastTime: "2026-01-06T18:00:00.000Z",
      images: 0,
      attachmentCount: 0,
      exchanges: [exchange("g5", "2026-01-06T18:00:00.000Z", "How many words fit on one page at 12pt?", "Roughly 500 words single spaced and 250 double spaced.")],
    },
  ];
  return {
    prompts: 24,
    conversations: 9,
    withResponse: 21,
    images: 4,
    attachedFiles: 6,
    otherEntries: 0,
    parsedFiles: 1,
    malformedEntries: 0,
    warnings: [],
    dateRange: { start: "2025-06-13T10:00:00.000Z", end: "2026-09-10T13:17:00.000Z" },
    byMonth: [
      { label: "2025-06", count: 2 },
      { label: "2025-12", count: 3 },
      { label: "2026-01", count: 5 },
      { label: "2026-03", count: 8 },
      { label: "2026-08", count: 4 },
      { label: "2026-09", count: 2 },
    ],
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, count: hour >= 9 && hour <= 22 ? 1 + (hour % 3) : 0 })),
    byWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ label, count: 2 + (index % 4) })),
    daily: demoDaily("2025-06-03", "2026-09-28", 24, 0.03, 5),
    busiestDay: { date: "2026-01-06", count: 5 },
    promptLengths: [
      { label: "Under 100", count: 15 },
      { label: "100 to 499", count: 6 },
      { label: "500 to 1,999", count: 2 },
      { label: "2,000 or more", count: 1 },
    ],
    medianPromptChars: 58,
    longestPromptChars: 3_400,
    longestConversationPrompts: 6,
    attachmentTypes: [
      { label: "py", count: 2 },
      { label: "png", count: 2 },
      { label: "txt", count: 1 },
      { label: "json", count: 1 },
    ],
    folderFiles: { count: 10, bytes: 4_800_000 },
    conversationList: conversations,
    conversationLimit: 300,
    isConversationListCapped: false,
  };
}

// Made-up shops and amounts so the Gmail order totals can be shown without anyone's real purchases.
function buildMailSpendDemo(): GoogleMailSpend {
  const orders: SpendOrder[] = [];
  const at = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime();
  for (let index = 0; index < 54; index += 1) {
    const month = 1 + ((index * 2) % 12);
    orders.push({ domain: "food.example", name: "Sample Takeaway", ms: at(2023 + Math.floor(index / 20), month, 3 + (index % 24)), amount: Math.round((18 + Math.abs(Math.sin(index * 1.7)) * 17) * 100) / 100, currency: "EUR" });
  }
  for (let index = 0; index < 20; index += 1) orders.push({ domain: "stream.example", name: "Sample Stream", ms: at(2025 + Math.floor(index / 12), 1 + (index % 12), 12), amount: 4.99, currency: "EUR" });
  orders.push(
    { domain: "gadgets.example", name: "Sample Gadgets", ms: at(2024, 11, 24), amount: 172.16, currency: "EUR" },
    { domain: "gadgets.example", name: "Sample Gadgets", ms: at(2025, 6, 2), amount: 64.9, currency: "EUR" },
    { domain: "cinema.example", name: "Sample Cinema", ms: at(2024, 8, 17), amount: 41.16, currency: "EUR" },
    { domain: "cinema.example", name: "Sample Cinema", ms: at(2025, 2, 9), amount: 28.4, currency: "EUR" },
    { domain: "market.example", name: "Sample Marketplace", ms: at(2025, 4, 21), amount: 10.5, currency: "EUR" },
    { domain: "uk-shop.example", name: "Sample UK Shop", ms: at(2024, 5, 5), amount: 24.5, currency: "GBP" },
  );
  return buildSpend(orders, 120, 118);
}

// Synthetic mailbox numbers with made-up .example senders; no real mail data.
function buildMailDemo(): GoogleMailSummary {
  const byMonth: { label: string; count: number }[] = [];
  for (let month = 0; month < 48; month += 1) {
    const year = 2021 + Math.floor(month / 12);
    const count = 18 + ((month * 7) % 23) + (month === 30 || month === 31 ? 160 : 0);
    byMonth.push({ label: `${year}-${String((month % 12) + 1).padStart(2, "0")}`, count });
  }
  const byYear = [2021, 2022, 2023, 2024].map((year) => ({ label: String(year), count: byMonth.filter((item) => item.label.startsWith(String(year))).reduce((sum, item) => sum + item.count, 0) }));
  const messages = byYear.reduce((sum, item) => sum + item.count, 0);
  const sender = (address: string, name: string, domain: string, count: number, opened: number, subscription: boolean, kind: "automated" | "personal" = "automated"): GoogleMailSender => ({
    address, name, domain, count, bytes: count * 41_000, firstDate: "2021-02-14T10:00:00.000Z", lastDate: "2024-11-02T09:30:00.000Z", opened, unread: 0, kind, subscription, ignored: subscription && opened === 0 && count >= 3,
  });
  const senders = [
    sender("hello@creatorhub.example", "CreatorHub", "creatorhub.example", 640, 40, false),
    sender("no-reply@foodnow.example", "FoodNow", "foodnow.example", 212, 17, false),
    sender("news@tradeapp.example", "TradeApp Weekly", "tradeapp.example", 160, 0, true),
    sender("deals@shopmart.example", "ShopMart Deals", "shopmart.example", 96, 0, true),
    sender("updates@devtools.example", "DevTools", "devtools.example", 44, 6, true),
    sender("sam@sample.example", "Sam Sample", "sample.example", 31, 29, false, "personal"),
    ...Array.from({ length: 12 }, (_, index) => sender(`news@brand${index + 1}.example`, `Brand ${index + 1}`, `brand${index + 1}.example`, 28 - index * 2, index % 3 === 0 ? 4 : 0, index % 2 === 0)),
  ];
  const domain = (name: string, count: number, senderCount: number, first: string, last: string): GoogleMailDomain => ({ domain: name, count, bytes: count * 41_000, senders: senderCount, firstDate: first, lastDate: last, kind: "automated" });
  const domains = [
    domain("creatorhub.example", 640, 3, "2021-03-01T00:00:00.000Z", "2024-11-02T00:00:00.000Z"),
    domain("foodnow.example", 212, 2, "2021-05-10T00:00:00.000Z", "2024-10-20T00:00:00.000Z"),
    domain("tradeapp.example", 160, 2, "2022-01-05T00:00:00.000Z", "2024-11-01T00:00:00.000Z"),
    domain("shopmart.example", 96, 1, "2021-02-14T00:00:00.000Z", "2023-01-09T00:00:00.000Z"),
    domain("devtools.example", 44, 1, "2022-08-02T00:00:00.000Z", "2024-09-30T00:00:00.000Z"),
    ...Array.from({ length: 12 }, (_, index) => domain(`brand${index + 1}.example`, 28 - index * 2, 1, "2022-03-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z")),
  ];
  return {
    parsedFiles: 4,
    malformedFiles: 0,
    warnings: [],
    mboxFiles: 1,
    duplicatesSkipped: 0,
    messages,
    threads: Math.round(messages * 0.92),
    totalBytes: messages * 50_000,
    account: "demo@example.com",
    dateRange: { start: "2021-01-03T08:00:00.000Z", end: "2024-12-28T18:00:00.000Z" },
    undated: 0,
    sent: 17,
    received: messages - 17,
    unread: 34,
    opened: Math.round(messages * 0.26),
    hasOpenedData: true,
    automated: Math.round(messages * 0.95),
    personal: messages - Math.round(messages * 0.95),
    withAttachments: 153,
    unsubscribeMessages: 601,
    subscriptionSenders: 136,
    ignoredSubscriptionSenders: 29,
    ignoredSubscriptionMessages: 166,
    ignoredSubscriptionBytes: 10_752_485,
    uniqueSenders: 556,
    uniqueDomains: 292,
    byYear,
    byMonth,
    byWeekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ label, count: 500 + ((index * 83) % 190) })),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0"), count: 60 + Math.round(Math.abs(Math.sin((hour - 4) / 4)) * 240) })),
    daily: demoDaily("2018-09-20", "2026-09-18", messages, 0.25, 3),
    busiestDay: { date: "2023-07-31", count: 29 },
    spikes: [
      { month: "2023-07", count: 190, topSender: "hello@creatorhub.example", topSenderCount: 140 },
      { month: "2023-08", count: 185, topSender: "hello@creatorhub.example", topSenderCount: 120 },
    ],
    labels: [
      { label: "Inbox", count: messages - 40 },
      { label: "Category updates", count: Math.round(messages * 0.84) },
      { label: "Opened", count: Math.round(messages * 0.26) },
      { label: "Important", count: Math.round(messages * 0.2) },
      { label: "Category personal", count: 303 },
      { label: "Category promotions", count: 248 },
      { label: "Sent", count: 17 },
    ],
    userLabels: [{ label: "Receipts to file", count: 12 }],
    topSenders: senders,
    topDomains: domains,
    topDomainsBySize: [...domains].sort((a, b) => b.bytes - a.bytes),
    subscriptions: senders.filter((item) => item.subscription),
    footprint: {
      accountDomains: 189,
      quietMonths: 12,
      newDomainsByYear: [
        { label: "2021", count: 40 },
        { label: "2022", count: 21 },
        { label: "2023", count: 16 },
        { label: "2024", count: 34 },
      ],
      oldest: [domain("shopmart.example", 96, 1, "2021-02-14T00:00:00.000Z", "2023-01-09T00:00:00.000Z"), domain("creatorhub.example", 640, 3, "2021-03-01T00:00:00.000Z", "2024-11-02T00:00:00.000Z")],
      quiet: [domain("shopmart.example", 96, 1, "2021-02-14T00:00:00.000Z", "2023-01-09T00:00:00.000Z")],
    },
    settings: { filters: 3, blockedAddresses: 12, forwardingAddresses: 1 },
    storage: {
      attachmentCount: 207,
      attachmentBytes: 26_998_162,
      attachmentShare: 0.12,
      byType: [
        { extension: "pdf", count: 114, bytes: 7_967_188 },
        { extension: "zip", count: 3, bytes: 6_579_711 },
        { extension: "gif", count: 1, bytes: 2_780_402 },
        { extension: "html", count: 64, bytes: 1_840_760 },
        { extension: "jpg", count: 4, bytes: 966_251 },
        { extension: "png", count: 13, bytes: 88_116 },
      ],
      largest: [
        { sender: "sam@sample.example", name: "Sam Sample", date: "2023-05-04T09:00:00.000Z", bytes: 17_800_000, attachments: 5, subject: "Holiday photos and documents" },
        { sender: "deliveries@parcelco.example", name: "ParcelCo", date: "2024-02-11T14:20:00.000Z", bytes: 1_900_000, attachments: 0, subject: "Your order will arrive today" },
        { sender: "support@devtools.example", name: "DevTools Support", date: "2022-11-30T10:05:00.000Z", bytes: 1_300_000, attachments: 4, subject: "Information regarding your ticket" },
      ],
    },
    spend: buildMailSpendDemo(),
    purchases: {
      messages: 434,
      labelled: 281,
      subjectOnly: 153,
      shipping: 20,
      merchantCount: 62,
      merchants: [
        { domain: "foodnow.example", name: "FoodNow", count: 175, shipping: 0, firstDate: "2021-05-10T00:00:00.000Z", lastDate: "2024-10-20T00:00:00.000Z", activeMonths: 34, peakMonth: "2023-03", peakCount: 16 },
        { domain: "shopmart.example", name: "ShopMart", count: 26, shipping: 6, firstDate: "2021-02-14T00:00:00.000Z", lastDate: "2023-01-09T00:00:00.000Z", activeMonths: 9, peakMonth: "2021-11", peakCount: 4 },
        { domain: "cinemas.example", name: "Example Cinemas", count: 8, shipping: 0, firstDate: "2022-06-01T00:00:00.000Z", lastDate: "2024-08-12T00:00:00.000Z", activeMonths: 6, peakMonth: "2024-08", peakCount: 2 },
      ],
      stackMerchants: ["foodnow.example", "shopmart.example", "cinemas.example"],
      months: byMonth.map((item, index) => {
        const food = 2 + (index % 5);
        const shop = index % 7 === 0 ? 3 : 0;
        const cinema = index % 11 === 0 ? 2 : 0;
        return { label: item.label, total: food + shop + cinema + 1, byMerchant: { "foodnow.example": food, ...(shop ? { "shopmart.example": shop } : {}), ...(cinema ? { "cinemas.example": cinema } : {}) } };
      }),
    },
    security: {
      messages: 585,
      byKind: [
        { label: "Sign-in alerts", count: 349 },
        { label: "Verification codes and 2-step", count: 144 },
        { label: "Password changes and resets", count: 87 },
        { label: "Suspicious activity", count: 5 },
      ],
      byMonth: byMonth.map((item, index) => ({ label: item.label, count: 4 + ((index * 5) % 9) })),
      topSources: [
        { label: "accounts.example", count: 260 },
        { label: "mailservice.example", count: 45 },
        { label: "chatapp.example", count: 32 },
        { label: "foodnow.example", count: 18 },
      ],
      passwordServices: 31,
      firstDate: "2021-03-12T14:01:21.000Z",
      lastDate: "2024-12-18T20:29:02.000Z",
    },
  };
}

export const googleDemoData: GoogleUnpackedData = {
  generatedAt: "2026-09-30T18:30:00.000Z",
  summary: {
    archiveCount: 6,
    entryCount: 8_922,
    productCount: 39,
    selectedSize: 13_400_000_000,
    compressedSize: 13_380_000_000,
    uncompressedSize: 12_230_000_000,
    parsed: 11,
    deferred: 3_682,
    skipped: 0,
    malformed: 0,
    unsupported: 0,
  },
  archives: [
    { fileName: "takeout-20260919T042047Z-2-001.zip", size: 2_147_000_000, entries: 1_322, warnings: 0, status: "indexed" },
    { fileName: "takeout-20260919T042047Z-5-001.zip", size: 47_500_000, entries: 3_618, warnings: 0, status: "indexed" },
    { fileName: "takeout-20260919T042047Z-6-001.zip", size: 1_300_000, entries: 16, warnings: 0, status: "indexed" },
  ],
  products: [
    { product: "Google Photos", files: 7_336, compressedSize: 9_600_000_000, uncompressedSize: 9_780_000_000, parsed: 0, deferred: 3_682, skipped: 0, malformed: 0, unsupported: 0, serviceStatus: "deferred", extensions: [{ label: ".mp4", count: 410 }, { label: ".jpg", count: 2_902 }, { label: ".json", count: 3_654 }] },
    { product: "My Activity", files: 144, compressedSize: 234_000_000, uncompressedSize: 234_000_000, parsed: 8, deferred: 0, skipped: 0, malformed: 0, unsupported: 0, serviceStatus: "parsed", extensions: [{ label: ".html", count: 30 }, { label: ".png", count: 80 }] },
    { product: "Fit", files: 591, compressedSize: 166_000_000, uncompressedSize: 166_000_000, parsed: 0, deferred: 0, skipped: 0, malformed: 0, unsupported: 0, serviceStatus: "indexed", extensions: [{ label: ".json", count: 420 }, { label: ".csv", count: 171 }] },
    { product: "Chrome", files: 9, compressedSize: 69_000_000, uncompressedSize: 69_000_000, parsed: 1, deferred: 0, skipped: 0, malformed: 0, unsupported: 0, serviceStatus: "parsed", extensions: [{ label: ".json", count: 9 }] },
    { product: "YouTube and YouTube Music", files: 16, compressedSize: 1_300_000, uncompressedSize: 19_850_000, parsed: 2, deferred: 0, skipped: 0, malformed: 0, unsupported: 0, serviceStatus: "parsed", extensions: [{ label: ".html", count: 2 }, { label: ".csv", count: 4 }, { label: ".json", count: 10 }] },
  ],
  largestFiles: [
    { path: "Takeout/Google Photos/2025/trip-video.mp4", product: "Google Photos", fileName: "trip-video.mp4", sourceArchive: "takeout-2-001.zip", compressedSize: 640_000_000, uncompressedSize: 650_000_000, status: "deferred", reason: "Photos media is deferred" },
    { path: "Takeout/Mail/All mail Including Spam and Trash.mbox", product: "Mail", fileName: "All mail Including Spam and Trash.mbox", sourceArchive: "takeout-1-001.zip", compressedSize: 64_000_000, uncompressedSize: 206_000_000, status: "parsed", reason: "Parsed by the Gmail tab (headers only)" },
  ],
  services: [
    { key: "activity", label: "My Activity", status: "parsed", files: 144, note: "Activity trends parsed for the initial service set." },
    { key: "chrome", label: "Chrome History", status: "parsed", files: 9, note: "Browser history, domains, clients, and visit patterns parsed." },
    { key: "youtube", label: "YouTube", status: "parsed", files: 16, note: "Watch and search history parsed through the shared YouTube parser." },
    { key: "photos", label: "Google Photos metadata", status: "parsed", files: 7_336, note: "Sidecar metadata parsed; photo and video files stay zipped and unread." },
    { key: "games", label: "Play Games", status: "parsed", files: 14, note: "Playtime, streaks, achievements, scores, and XP parsed; account-linking tokens and cloud-save files are not read." },
    { key: "drive", label: "Drive", status: "parsed", files: 14, note: "File names, sizes, and dates read from the ZIP index; no Drive file is opened, and nested archives stay closed." },
    { key: "gemini", label: "Gemini", status: "parsed", files: 10, note: "Prompts, replies, and conversations parsed; attached and generated files are counted, not opened." },
    { key: "mail", label: "Gmail", status: "parsed", files: 4, note: "Mailbox headers scanned for senders, timing, and subscriptions; message text is read only if you opt in to order totals." },
  ],
  warnings: ["Demo data uses representative counts from the inspected export; upload your Takeout ZIPs for exact results."],
  activity: {
    total: 684_849,
    parsedFiles: 8,
    malformedEntries: 0,
    warnings: [],
    services: [
      { service: "Search", files: 1, parsedEntries: 233_067, malformedEntries: 0, bytes: 76_810_304, status: "parsed" },
      { service: "Chrome", files: 1, parsedEntries: 181_494, malformedEntries: 0, bytes: 57_834_272, status: "parsed" },
      { service: "Google Play Store", files: 1, parsedEntries: 89_787, malformedEntries: 0, bytes: 27_585_558, status: "parsed" },
      { service: "YouTube", files: 1, parsedEntries: 73_386, malformedEntries: 0, bytes: 23_255_244, status: "parsed" },
      { service: "Image Search", files: 1, parsedEntries: 72_555, malformedEntries: 0, bytes: 23_701_893, status: "parsed" },
    ],
    byService: [
      { label: "Search", count: 233_067 },
      { label: "Chrome", count: 181_494 },
      { label: "Google Play Store", count: 89_787 },
      { label: "YouTube", count: 73_386 },
      { label: "Image Search", count: 72_555 },
      { label: "Maps", count: 28_401 },
    ],
    topHosts: [
      { label: "google.com", count: 104_200 },
      { label: "youtube.com", count: 73_386 },
      { label: "play.google.com", count: 31_900 },
    ],
    activityByDay: [
      { date: "2026-09-24", count: 1820 },
      { date: "2026-09-25", count: 2054 },
      { date: "2026-09-26", count: 1944 },
      { date: "2026-09-27", count: 2120 },
      { date: "2026-09-28", count: 1762 },
      { date: "2026-09-29", count: 2210 },
    ],
    activityByWeek: [
      { label: "2026-09-07", count: 12_800 },
      { label: "2026-09-14", count: 14_200 },
      { label: "2026-09-21", count: 13_910 },
    ],
    activityByMonth: [
      { label: "2026-07", count: 61_200 },
      { label: "2026-08", count: 68_300 },
      { label: "2026-09", count: 72_400 },
    ],
    activityByYear: [
      { label: "2024", count: 192_000 },
      { label: "2025", count: 261_000 },
      { label: "2026", count: 231_849 },
    ],
    activityByHour: Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, count: 400 + ((hour * 173) % 900) })),
    activityByWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ label, count: 80_000 + index * 4_500 })),
    daily: {
      other: demoDaily("2020-10-02", "2026-09-29", 560_000, 0.92, 1),
      chrome: demoDaily("2020-10-02", "2025-09-18", 90_000, 0.7, 2),
      youtube: demoDaily("2021-01-05", "2026-09-29", 34_000, 0.6, 4),
    },
    busiestDay: { date: "2026-09-29", count: 2_210 },
    longestActiveStreak: { days: 298, startDate: "2024-09-10", endDate: "2025-07-04" },
    recentEntries: [
      { id: "demo-1", service: "Search", action: "Searched for", title: "Searched for data export viewers", url: "https://www.google.com/search?q=data+export+viewers", host: "google.com", time: "2026-09-29T21:10:00.000Z", products: ["Search"], detailCount: 0, hasLocation: false, sourcePath: "Takeout/My Activity/Search/My Activity.html" },
      { id: "demo-2", service: "Chrome", action: "Visited", title: "Visited Google Takeout Viewer", url: "https://example.com/google-takeout-viewer", host: "example.com", time: "2026-09-29T20:43:00.000Z", products: ["Chrome"], detailCount: 0, hasLocation: false, sourcePath: "Takeout/My Activity/Chrome/My Activity.html" },
      { id: "demo-3", service: "Maps", action: "Viewed", title: "Viewed a place", url: "https://www.google.com/maps", host: "google.com", time: "2026-09-28T12:22:00.000Z", products: ["Maps"], detailCount: 1, hasLocation: true, sourcePath: "Takeout/My Activity/Maps/My Activity.html" },
    ],
    recentEntryLimit: 2_000,
    isEntryListCapped: true,
    timestampWarning: true,
  },
  chromeHistory: {
    total: 167_400,
    parsedFiles: 1,
    typedUrlRows: 0,
    sessionRows: 23,
    sharedTabGroupRows: 0,
    invalidUrlRows: 0,
    warnings: [],
    dateRange: { start: "2025-09-19T15:16:19.985Z", end: "2026-09-19T04:20:18.912Z" },
    uniqueHosts: 18_240,
    uniqueClients: 3,
    topHosts: [
      { label: "google.com", count: 23_820 },
      { label: "youtube.com", count: 18_440 },
      { label: "github.com", count: 4_260 },
      { label: "example.com", count: 930 },
    ],
    devices: [
      { label: "Example Laptop", platform: "Windows desktop", chromeVersion: "Chrome 153", listed: true, visits: 141_000, share: 141_000 / 167_400, firstSeen: "2025-09-19T15:16:19.985Z", lastSeen: "2026-09-19T04:20:18.912Z", topHosts: [{ label: "youtube.com", count: 18_440 }, { label: "google.com", count: 12_300 }, { label: "github.com", count: 4_260 }] },
      { label: "Galaxy S23+", platform: "Android phone", chromeVersion: "Chrome 153", listed: true, visits: 21_400, share: 21_400 / 167_400, firstSeen: "2026-01-13T09:02:00.000Z", lastSeen: "2026-07-05T18:40:00.000Z", topHosts: [{ label: "example.com", count: 3_200 }, { label: "google.com", count: 2_400 }, { label: "viewer.example", count: 520 }] },
      { label: "Older install 1", listed: false, visits: 5_000, share: 5_000 / 167_400, firstSeen: "2026-07-14T11:30:00.000Z", lastSeen: "2026-09-18T20:05:00.000Z", topHosts: [{ label: "google.com", count: 1_100 }, { label: "support.google.com", count: 410 }, { label: "example.org", count: 200 }] },
    ],
    signedInWithoutHistory: [{ label: "Example Tablet", platform: "Android tablet" }],
    historyByDay: [
      { date: "2026-09-14", count: 482 },
      { date: "2026-09-15", count: 514 },
      { date: "2026-09-16", count: 604 },
      { date: "2026-09-17", count: 551 },
      { date: "2026-09-18", count: 488 },
      { date: "2026-09-19", count: 319 },
    ],
    historyByWeek: [
      { label: "2026-08-31", count: 4_420 },
      { label: "2026-09-07", count: 4_880 },
      { label: "2026-09-14", count: 2_958 },
    ],
    historyByMonth: [
      { label: "2026-07", count: 12_900 },
      { label: "2026-08", count: 13_600 },
      { label: "2026-09", count: 10_900 },
    ],
    historyByYear: [
      { label: "2025", count: 48_700 },
      { label: "2026", count: 118_700 },
    ],
    historyByHour: Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, count: 900 + ((hour * 241) % 1_500) })),
    historyByWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ label, count: 18_000 + index * 1_240 })),
    daily: demoDaily("2025-09-30", "2026-09-29", 167_400, 0.85, 6),
    busiestDay: { date: "2026-09-16", count: 604 },
    recentEntries: [
      { id: "chrome-demo-1", title: "Google Takeout Viewer", url: "https://example.com/google-takeout-viewer", host: "example.com", time: "2026-09-19T04:20:18.912Z", deviceLabel: "Example Laptop", sourcePath: "Takeout/Chrome/History.json" },
      { id: "chrome-demo-2", title: "Chrome history export notes", url: "https://support.google.com/accounts/answer/3024190", host: "support.google.com", time: "2026-09-19T03:58:02.120Z", deviceLabel: "Example Laptop", sourcePath: "Takeout/Chrome/History.json" },
      { id: "chrome-demo-3", title: "Local-first data tools", url: "https://example.com/local-data-tools", host: "example.com", time: "2026-09-18T22:14:44.001Z", deviceLabel: "Example Laptop", sourcePath: "Takeout/Chrome/History.json" },
    ],
    recentEntryLimit: 2_000,
    isEntryListCapped: true,
  },
  photos: {
    total: 3_654,
    photos: 2_902,
    videos: 410,
    otherMedia: 342,
    parsedFiles: 3_654,
    malformedFiles: 0,
    warnings: [],
    dateRange: { start: "2011-06-14T12:00:00.000Z", end: "2026-09-12T18:04:00.000Z" },
    withLocation: 812,
    withDescription: 94,
    favorited: 61,
    archived: 12,
    trashed: 0,
    totalViews: 18_420,
    albumCount: 3,
    yearFolderCount: 9,
    topAlbums: [
      { label: "Trip to Lisbon", count: 210 },
      { label: "Family", count: 148 },
      { label: "Screenshots", count: 96 },
    ],
    byYear: [
      { label: "2019", count: 312 },
      { label: "2020", count: 280 },
      { label: "2021", count: 505 },
      { label: "2022", count: 610 },
      { label: "2023", count: 702 },
      { label: "2024", count: 820 },
      { label: "2025", count: 340 },
      { label: "2026", count: 85 },
    ],
    byMonth: [
      { label: "2025-06", count: 64 },
      { label: "2025-07", count: 120 },
      { label: "2025-08", count: 88 },
      { label: "2025-09", count: 41 },
      { label: "2025-10", count: 27 },
    ],
    byWeekday: [
      { label: "Sun", count: 690 },
      { label: "Mon", count: 360 },
      { label: "Tue", count: 380 },
      { label: "Wed", count: 410 },
      { label: "Thu", count: 420 },
      { label: "Fri", count: 530 },
      { label: "Sat", count: 864 },
    ],
    byHour: Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, "0")}:00`, count: [2, 1, 0, 0, 0, 1, 6, 18, 40, 62, 88, 120, 150, 140, 130, 120, 140, 180, 210, 190, 140, 90, 40, 12][hour] })),
    uploadsByYear: [
      { label: "2022", count: 410 },
      { label: "2023", count: 1_100 },
      { label: "2024", count: 1_600 },
      { label: "2025", count: 480 },
      { label: "2026", count: 64 },
    ],
    sources: [
      { label: "Mobile app upload", count: 3_410 },
      { label: "Web upload", count: 160 },
      { label: "Partner sharing", count: 84 },
    ],
    deviceTypes: [
      { label: "ANDROID_PHONE", count: 3_201 },
      { label: "IOS_PHONE", count: 209 },
    ],
    deviceFolders: [
      { label: "Camera", count: 2_480 },
      { label: "Snapchat", count: 410 },
      { label: "Screenshots", count: 96 },
    ],
    extensions: [
      { label: ".jpg", count: 2_700 },
      { label: ".mp4", count: 410 },
      { label: ".png", count: 202 },
    ],
    daily: demoDaily("2019-05-10", "2026-08-30", 3_654, 0.12, 8),
    busiestDay: { date: "2024-07-14", count: 58 },
    recentEntries: [
      { id: "photos-demo-1", title: "IMG_20260912_180400.jpg", mediaType: "photo", takenAt: "2026-09-12T18:04:00.000Z", uploadedAt: "2026-09-12T18:06:10.000Z", source: "Mobile app upload", deviceType: "ANDROID_PHONE", deviceFolder: "Camera", albumFolder: "Photos from 2026", views: 3, hasLocation: true, latitude: 38.7223, longitude: -9.1393, favorited: false, url: "https://photos.google.com/photo/demo1", sourcePath: "Takeout/Google Photos/Photos from 2026/IMG_20260912_180400.jpg.supplemental-metadata.json" },
      { id: "photos-demo-2", title: "VID_20260830_121500.mp4", mediaType: "video", takenAt: "2026-08-30T12:15:00.000Z", uploadedAt: "2026-08-30T12:30:00.000Z", source: "Mobile app upload", deviceType: "ANDROID_PHONE", deviceFolder: "Camera", albumFolder: "Photos from 2026", views: 7, hasLocation: false, favorited: true, url: "https://photos.google.com/photo/demo2", sourcePath: "Takeout/Google Photos/Photos from 2026/VID_20260830_121500.mp4.supplemental-metadata.json" },
    ],
    recentEntryLimit: 2_000,
    isEntryListCapped: true,
    sharedAlbumComments: 3,
  },
  playStore: {
    installs: {
      total: 1_320,
      uniqueApps: 279,
      multiDeviceApps: 174,
      byYear: [
        { label: "2020", count: 69 },
        { label: "2021", count: 187 },
        { label: "2023", count: 109 },
        { label: "2024", count: 135 },
        { label: "2025", count: 6 },
        { label: "2026", count: 808 },
      ],
      byDevice: [
        { label: "samsung SM-G986B", count: 572 },
        { label: "samsung SM-N960F", count: 206 },
        { label: "samsung SM-S916B", count: 153 },
      ],
      byType: [{ label: "Android Apps", count: 1_320 }],
      recent: [
        { title: "Glovo: Food & Grocery Delivery", documentType: "Android Apps", device: "samsung SM-S916B", firstInstalledAt: "2026-09-17T07:23:26.245Z", lastUpdatedAt: "2026-09-18T02:05:50.196Z" },
        { title: "Offline Maps", documentType: "Android Apps", device: "samsung SM-G986B", firstInstalledAt: "2026-08-02T10:10:00.000Z", lastUpdatedAt: "2026-09-01T10:10:00.000Z" },
      ],
      oldest: [{ title: "Retro Racer", documentType: "Android Apps", device: "", firstInstalledAt: "2019-10-03T21:53:57.115Z", lastUpdatedAt: "2019-10-03T21:53:57.280Z" }],
      recentLimit: 2_000,
      isCapped: false,
    },
    purchases: {
      total: 60,
      free: 22,
      paid: 38,
      spend: [{ currency: "\u20ac", total: 119.38, purchases: 38 }],
      byYear: [
        { label: "2021", count: 13 },
        { label: "2023", count: 8 },
        { label: "2024", count: 18 },
        { label: "2025", count: 9 },
        { label: "2026", count: 6 },
      ],
      byType: [
        { label: "In App Item", count: 35 },
        { label: "Android Apps", count: 22 },
        { label: "Subscription", count: 2 },
      ],
      paymentMethods: [{ label: "Mastercard-0000", count: 40 }],
      topPaid: [{ title: "Coin Pack (Demo Game)", documentType: "In App Item", price: "\u20ac9.99", amount: 9.99, currency: "\u20ac", paymentMethod: "Mastercard-0000", time: "2025-03-01T12:00:00.000Z" }],
      recent: [{ title: "Coin Pack (Demo Game)", documentType: "In App Item", price: "\u20ac9.99", amount: 9.99, currency: "\u20ac", paymentMethod: "Mastercard-0000", time: "2025-03-01T12:00:00.000Z" }],
      recentLimit: 2_000,
      isCapped: false,
    },
    library: { total: 60, byType: [{ label: "In App Item", count: 35 }, { label: "Android Apps", count: 22 }] },
    orders: { total: 40, byYear: [{ label: "2024", count: 18 }, { label: "2025", count: 9 }] },
    subscriptions: [
      { title: "Cloud Storage 100 GB", state: "Canceled", price: "\u20ac1.99", period: "1 month", expirationDate: "2023-09-14T15:36:22.975Z" },
      { title: "Chat App Plus", state: "Active", price: "\u20ac9.99", period: "1 month", renewalDate: "2026-10-16T17:54:43.517Z" },
    ],
    devices: [
      { label: "samsung SM-N960F", manufacturer: "samsung", model: "SM-N960F", androidSdk: "29", memoryGb: 5.5, country: "IE", locale: "en_AU", registeredAt: "2026-07-07T02:08:21.505Z", lastActiveAt: "2026-09-19T01:34:32.457Z" },
      { label: "samsung SM-G986B", manufacturer: "samsung", model: "SM-G986B", androidSdk: "33", memoryGb: 10.6, country: "IE", locale: "en_IE", registeredAt: "2020-09-01T10:00:00.000Z", lastActiveAt: "2026-06-01T10:00:00.000Z" },
    ],
    playPoints: { level: "Bronze", status: "Active", balance: 178, historyRows: 45 },
    interestSettings: 11,
    promotionRows: 2,
    dateRange: { start: "2018-12-12T18:20:41.037Z", end: "2026-09-19T01:37:56.446Z" },
    parsedFiles: 9,
    warnings: [],
  },
  fit: buildFitDemo(),
  mail: buildMailDemo(),
  gemini: buildGeminiDemo(),
  playGames: buildPlayGamesDemo(),
  drive: buildDriveDemo(),
  moreServices: {
    parsedFiles: 22,
    warnings: [],
    contacts: {
      total: 108,
      withPhone: 68,
      withEmail: 41,
      withOrganization: 4,
      withPhoto: 10,
      photoFiles: 20,
      exportFiles: 7,
      list: [
        { name: "Alex Example", phones: ["+353 85 000 0000"], emails: [], hasPhoto: true },
        { name: "Sam Sample", phones: [], emails: ["sam@example.com"], hasPhoto: false },
      ],
      isCapped: false,
    },
    calendar: {
      calendars: ["demo@example.com"],
      total: 8,
      recurring: 2,
      allDay: 2,
      withAttendees: 3,
      withLocation: 4,
      byYear: [
        { label: "2021", count: 1 },
        { label: "2024", count: 3 },
        { label: "2025", count: 2 },
        { label: "2026", count: 1 },
      ],
      dateRange: { start: "2021-06-26T00:00:00.000Z", end: "2026-01-10T12:50:00.000Z" },
      list: [
        { title: "Dentist appointment", start: "2026-01-10T12:50:00.000Z", end: "2026-01-10T13:00:00.000Z", allDay: false, recurring: false, location: "Main Street Clinic", attendees: 0, status: "CONFIRMED" },
        { title: "Birthday", start: "2021-06-26T00:00:00.000Z", allDay: true, recurring: true, attendees: 0, status: "CONFIRMED" },
      ],
      isCapped: false,
    },
    tasks: { lists: ["My Tasks"], total: 0, completed: 0, list: [] },
    saved: {
      total: 5,
      lists: [
        { name: "Favourite places", count: 1, items: [{ title: "Corner Cafe", url: "https://www.google.com/maps/place/demo" }] },
        { name: "Saved for later", count: 1, items: [{ title: "Synth wiki", url: "https://example.com/synth" }] },
      ],
    },
    pay: {
      total: 61,
      spend: [{ currency: "EUR", total: 146.27, count: 53 }],
      byStatus: [{ label: "Complete", count: 55 }, { label: "Cancelled", count: 5 }, { label: "Refunded", count: 1 }],
      byProduct: [{ label: "Google Play Apps", count: 39 }, { label: "YouTube", count: 18 }],
      byYear: [{ label: "2024", count: 15 }, { label: "2025", count: 21 }, { label: "2026", count: 10 }],
      list: [
        { time: "2026-09-18T18:31:00.000Z", id: "GPA.0000-0000-0000-00000", description: "Coin pack (Demo Game)", product: "Google Play Apps", paymentMethod: "Mastercard 0000", status: "Complete", amount: 5.2, currency: "EUR" },
      ],
      isCapped: false,
    },
    chat: {
      conversations: [{ id: "DM demo", members: ["You", "Sample Friend"], messages: 62, first: "2021-09-25T15:44:37.000Z", last: "2021-12-18T16:44:44.000Z" }],
      messages: 62,
      sent: 37,
      received: 25,
      byYear: [{ label: "2021", count: 62 }],
      recent: [{ conversation: "DM demo", sender: "Sample Friend", fromSelf: false, time: "2021-12-18T16:44:44.000Z", text: "are you there" }],
      isCapped: false,
    },
    contributions: { reviews: 2, thumbs: 2, productReviews: 0, merchantReviews: 0 },
  },
  youtube: {
    fileName: "Google Takeout YouTube history",
    generatedAt: "2026-09-30T18:30:00.000Z",
    sourceFiles: ["search-history.html", "watch-history.html"],
    coverage: [
      { key: "watch", label: "Watch history", firstDate: "2025-09-19T15:16:19.000Z", lastDate: "2026-09-19T04:18:12.000Z" },
      { key: "search", label: "Search history", firstDate: "2025-09-20T10:11:05.000Z", lastDate: "2026-09-18T22:40:00.000Z" },
    ],
    watch: {
      total: 18_614,
      adViews: 210,
      removedOrUnavailable: 42,
      distinctChannels: 6_840,
      busiestDay: { date: "2026-04-12", count: 328 },
      recent: [
        { title: "Building a local-first dashboard", videoUrl: "https://www.youtube.com/watch?v=demo1", channelName: "Data Tools Daily", channelUrl: "https://www.youtube.com/channel/demo1", time: "2026-09-19T04:18:12.000Z", isAd: false, isRemoved: false },
        { title: "Synth setup walkthrough", videoUrl: "https://music.youtube.com/watch?v=demo2", channelName: "Patch Notes", channelUrl: "https://www.youtube.com/channel/demo2", time: "2026-09-19T03:40:00.000Z", isAd: false, isRemoved: false },
      ],
    },
    search: {
      total: 2_010,
      distinctQueries: 4_910,
      busiestDay: { date: "2026-05-04", count: 61 },
      recent: [
        { query: "local data viewer", resultUrl: "https://www.youtube.com/results?search_query=local+data+viewer", time: "2026-09-18T22:40:00.000Z" },
        { query: "recharts dashboard examples", resultUrl: "https://www.youtube.com/results?search_query=recharts+dashboard+examples", time: "2026-09-18T18:12:00.000Z" },
      ],
    },
    topChannels: [
      { label: "Data Tools Daily", count: 1_420, channelUrl: "https://www.youtube.com/channel/demo1" },
      { label: "Patch Notes", count: 1_030, channelUrl: "https://www.youtube.com/channel/demo2" },
      { label: "Longform Labs", count: 812, channelUrl: "https://www.youtube.com/channel/demo3" },
    ],
    topSearchQueries: [
      { label: "local data viewer", count: 44 },
      { label: "typescript zip parser", count: 31 },
      { label: "recharts dashboard examples", count: 27 },
    ],
    activityByDay: [
      { date: "2026-09-14", count: 188 },
      { date: "2026-09-15", count: 214 },
      { date: "2026-09-16", count: 240 },
      { date: "2026-09-17", count: 201 },
      { date: "2026-09-18", count: 231 },
      { date: "2026-09-19", count: 122 },
    ],
    activityByWeek: [
      { label: "2026-08-31", count: 1_480 },
      { label: "2026-09-07", count: 1_620 },
      { label: "2026-09-14", count: 1_196 },
    ],
    activityByMonth: [
      { label: "2026-07", count: 5_120 },
      { label: "2026-08", count: 5_640 },
      { label: "2026-09", count: 4_880 },
    ],
    activityByYear: [
      { label: "2025", count: 6_480 },
      { label: "2026", count: 14_144 },
    ],
    activityByHour: [
      "12 AM", "1 AM", "2 AM", "3 AM", "4 AM", "5 AM", "6 AM", "7 AM", "8 AM", "9 AM", "10 AM", "11 AM",
      "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM", "9 PM", "10 PM", "11 PM",
    ].map((label, index) => ({ label, count: 120 + ((index * 97) % 420) })),
    activityByWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ label, count: 7_200 + index * 520 })),
    topRewatchedVideos: [
      { title: "Building a local-first dashboard", count: 34, videoUrl: "https://www.youtube.com/watch?v=demo1", channelName: "Data Tools Daily" },
      { title: "Synth setup walkthrough", count: 22, videoUrl: "https://music.youtube.com/watch?v=demo2", channelName: "Patch Notes" },
    ],
    longestActiveStreak: { days: 301, startDate: "2025-10-02", endDate: "2026-07-29" },
    musicWatchShare: 0.08,
    exportSections: [
      { key: "watch", label: "Watch history", description: "Videos and ads YouTube recorded you watching, with channel and timestamp.", files: ["watch-history.json", "watch-history.html"], rows: 18_614, status: "found" },
      { key: "search", label: "Search history", description: "Search queries run on YouTube, with timestamp and result link.", files: ["search-history.json", "search-history.html"], rows: 2_010, status: "found" },
    ],
    warnings: [
      "Parsed from the HTML export format. Timestamps use the time zone label Google Takeout printed without adjusting for it.",
    ],
  },
};
