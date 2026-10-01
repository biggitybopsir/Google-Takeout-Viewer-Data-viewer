import type { YouTubeUnpackedData } from "@/platforms/youtube/types";

export type GoogleParserStage = "reading" | "indexing" | "extracting" | "parsing" | "analyzing" | "complete";

export type GoogleParserProgress = {
  stage: GoogleParserStage;
  label: string;
  percent: number;
};

export type GoogleParserError = {
  fileName?: string;
  message: string;
};

export type GoogleRankedItem = {
  label: string;
  count: number;
  url?: string;
};

export type GoogleDayCount = {
  date: string;
  count: number;
};

export type GoogleCoverageStatus = "indexed" | "parsed" | "deferred" | "skipped" | "malformed" | "unsupported";

export type GoogleArchiveSummary = {
  fileName: string;
  size: number;
  entries: number;
  warnings: number;
  status: "indexed" | "failed";
};

export type GoogleProductSummary = {
  product: string;
  files: number;
  compressedSize: number;
  uncompressedSize: number;
  parsed: number;
  deferred: number;
  skipped: number;
  malformed: number;
  unsupported: number;
  extensions: GoogleRankedItem[];
  serviceStatus: GoogleCoverageStatus;
};

export type GoogleLargestFile = {
  path: string;
  product: string;
  fileName: string;
  sourceArchive: string;
  compressedSize: number;
  uncompressedSize: number;
  status: GoogleCoverageStatus;
  reason?: string;
};

export type GoogleServiceAvailability = {
  key: string;
  label: string;
  status: "available" | "parsed" | "deferred" | "missing";
  files: number;
  note: string;
};

export type GoogleActivityEntry = {
  id: string;
  service: string;
  action?: string;
  title?: string;
  url?: string;
  host?: string;
  time?: string;
  products: string[];
  detailCount: number;
  hasLocation: boolean;
  sourcePath: string;
};

export type GoogleActivityServiceSummary = {
  service: string;
  files: number;
  parsedEntries: number;
  malformedEntries: number;
  bytes: number;
  status: GoogleCoverageStatus;
};

export type GoogleActivitySummary = {
  total: number;
  parsedFiles: number;
  malformedEntries: number;
  warnings: string[];
  services: GoogleActivityServiceSummary[];
  byService: GoogleRankedItem[];
  topHosts: GoogleRankedItem[];
  activityByDay: GoogleDayCount[];
  /** Every day with activity (not just the recent ones), split so Chrome and YouTube rows are not double counted against their own tabs. */
  daily: { other: GoogleDayCount[]; chrome: GoogleDayCount[]; youtube: GoogleDayCount[] };
  activityByWeek: GoogleRankedItem[];
  activityByMonth: GoogleRankedItem[];
  activityByYear: GoogleRankedItem[];
  activityByHour: GoogleRankedItem[];
  activityByWeekday: GoogleRankedItem[];
  busiestDay?: GoogleDayCount;
  longestActiveStreak?: { days: number; startDate: string; endDate: string };
  recentEntries: GoogleActivityEntry[];
  recentEntryLimit: number;
  isEntryListCapped: boolean;
  timestampWarning: boolean;
};

export type GoogleChromeHistoryEntry = {
  id: string;
  title?: string;
  url?: string;
  host?: string;
  time?: string;
  deviceLabel?: string;
  sourcePath: string;
};

export type GoogleChromeDevice = {
  label: string;
  platform?: string;
  chromeVersion?: string;
  listed: boolean;
  visits: number;
  share: number;
  firstSeen?: string;
  lastSeen?: string;
  topHosts: GoogleRankedItem[];
};

export type GoogleChromeHistorySummary = {
  total: number;
  parsedFiles: number;
  typedUrlRows: number;
  sessionRows: number;
  sharedTabGroupRows: number;
  invalidUrlRows: number;
  warnings: string[];
  dateRange?: { start?: string; end?: string };
  uniqueHosts: number;
  uniqueClients: number;
  topHosts: GoogleRankedItem[];
  devices: GoogleChromeDevice[];
  signedInWithoutHistory: { label: string; platform?: string }[];
  historyByDay: GoogleDayCount[];
  /** Every day with visits, oldest first. */
  daily: GoogleDayCount[];
  historyByWeek: GoogleRankedItem[];
  historyByMonth: GoogleRankedItem[];
  historyByYear: GoogleRankedItem[];
  historyByHour: GoogleRankedItem[];
  historyByWeekday: GoogleRankedItem[];
  busiestDay?: GoogleDayCount;
  recentEntries: GoogleChromeHistoryEntry[];
  recentEntryLimit: number;
  isEntryListCapped: boolean;
};

export type GooglePhotosEntry = {
  id: string;
  title?: string;
  mediaType: "photo" | "video" | "other";
  takenAt?: string;
  uploadedAt?: string;
  source?: string;
  deviceType?: string;
  deviceFolder?: string;
  albumFolder?: string;
  views: number;
  hasLocation: boolean;
  latitude?: number;
  longitude?: number;
  favorited: boolean;
  url?: string;
  sourcePath: string;
};

export type GooglePhotosSummary = {
  total: number;
  photos: number;
  videos: number;
  otherMedia: number;
  parsedFiles: number;
  malformedFiles: number;
  warnings: string[];
  dateRange?: { start?: string; end?: string };
  withLocation: number;
  withDescription: number;
  favorited: number;
  archived: number;
  trashed: number;
  totalViews: number;
  albumCount: number;
  yearFolderCount: number;
  topAlbums: GoogleRankedItem[];
  byYear: GoogleRankedItem[];
  byMonth: GoogleRankedItem[];
  byWeekday: GoogleRankedItem[];
  byHour: GoogleRankedItem[];
  uploadsByYear: GoogleRankedItem[];
  sources: GoogleRankedItem[];
  deviceTypes: GoogleRankedItem[];
  deviceFolders: GoogleRankedItem[];
  extensions: GoogleRankedItem[];
  /** Every day with at least one item, oldest first. */
  daily: GoogleDayCount[];
  busiestDay?: GoogleDayCount;
  recentEntries: GooglePhotosEntry[];
  recentEntryLimit: number;
  isEntryListCapped: boolean;
  sharedAlbumComments: number;
};

export type GooglePlayInstall = {
  title: string;
  documentType?: string;
  device?: string;
  firstInstalledAt?: string;
  lastUpdatedAt?: string;
};

export type GooglePlayPurchase = {
  title: string;
  documentType?: string;
  price?: string;
  amount: number;
  currency?: string;
  paymentMethod?: string;
  time?: string;
};

export type GooglePlaySubscription = {
  title: string;
  state?: string;
  price?: string;
  period?: string;
  renewalDate?: string;
  expirationDate?: string;
};

export type GooglePlayDevice = {
  label: string;
  manufacturer?: string;
  model?: string;
  androidSdk?: string;
  memoryGb?: number;
  country?: string;
  locale?: string;
  registeredAt?: string;
  lastActiveAt?: string;
};

export type GooglePlaySpend = {
  currency: string;
  total: number;
  purchases: number;
};

export type GooglePlaySummary = {
  installs: {
    total: number;
    uniqueApps: number;
    multiDeviceApps: number;
    byYear: GoogleRankedItem[];
    byDevice: GoogleRankedItem[];
    byType: GoogleRankedItem[];
    recent: GooglePlayInstall[];
    oldest: GooglePlayInstall[];
    recentLimit: number;
    isCapped: boolean;
  };
  purchases: {
    total: number;
    free: number;
    paid: number;
    spend: GooglePlaySpend[];
    byYear: GoogleRankedItem[];
    byType: GoogleRankedItem[];
    paymentMethods: GoogleRankedItem[];
    topPaid: GooglePlayPurchase[];
    recent: GooglePlayPurchase[];
    recentLimit: number;
    isCapped: boolean;
  };
  library: { total: number; byType: GoogleRankedItem[] };
  orders: { total: number; byYear: GoogleRankedItem[] };
  subscriptions: GooglePlaySubscription[];
  devices: GooglePlayDevice[];
  playPoints?: { level?: string; status?: string; balance?: number; historyRows: number };
  interestSettings: number;
  promotionRows: number;
  dateRange?: { start?: string; end?: string };
  parsedFiles: number;
  warnings: string[];
};

export type GoogleContact = {
  name: string;
  phones: string[];
  emails: string[];
  organization?: string;
  hasPhoto: boolean;
};

export type GoogleCalendarEvent = {
  title: string;
  start?: string;
  end?: string;
  allDay: boolean;
  recurring: boolean;
  location?: string;
  attendees: number;
  status?: string;
};

export type GoogleTask = {
  title: string;
  list: string;
  status?: string;
  due?: string;
  updated?: string;
  hasNotes: boolean;
};

export type GoogleSavedList = {
  name: string;
  count: number;
  items: { title?: string; note?: string; url?: string }[];
};

export type GoogleTransaction = {
  time?: string;
  id?: string;
  description: string;
  product?: string;
  paymentMethod?: string;
  status?: string;
  amount: number;
  currency?: string;
};

export type GoogleChatMessage = {
  conversation: string;
  sender: string;
  fromSelf: boolean;
  time?: string;
  text: string;
};

export type GoogleMoreServices = {
  contacts?: {
    total: number;
    withPhone: number;
    withEmail: number;
    withOrganization: number;
    withPhoto: number;
    photoFiles: number;
    exportFiles: number;
    list: GoogleContact[];
    isCapped: boolean;
  };
  calendar?: {
    calendars: string[];
    total: number;
    recurring: number;
    allDay: number;
    withAttendees: number;
    withLocation: number;
    byYear: GoogleRankedItem[];
    dateRange?: { start?: string; end?: string };
    list: GoogleCalendarEvent[];
    isCapped: boolean;
  };
  tasks?: { lists: string[]; total: number; completed: number; list: GoogleTask[] };
  saved?: { lists: GoogleSavedList[]; total: number };
  pay?: {
    total: number;
    spend: { currency: string; total: number; count: number }[];
    byStatus: GoogleRankedItem[];
    byProduct: GoogleRankedItem[];
    byYear: GoogleRankedItem[];
    list: GoogleTransaction[];
    isCapped: boolean;
  };
  chat?: {
    conversations: { id: string; members: string[]; messages: number; first?: string; last?: string }[];
    messages: number;
    sent: number;
    received: number;
    byYear: GoogleRankedItem[];
    recent: GoogleChatMessage[];
    isCapped: boolean;
  };
  contributions?: { reviews: number; thumbs: number; productReviews: number; merchantReviews: number };
  parsedFiles: number;
  warnings: string[];
};

export type GoogleFitDay = {
  date: string;
  steps: number;
  distanceM: number;
  moveMinutes: number;
  heartPoints: number;
  calories: number;
};

export type GoogleFitPeriod = {
  label: string;
  steps: number;
  distanceKm: number;
  moveMinutes: number;
  heartPoints: number;
  activeDays: number;
};

export type GoogleFitSummary = {
  parsedFiles: number;
  malformedFiles: number;
  warnings: string[];
  totalDays: number;
  activeDays: number;
  dateRange?: { start: string; end: string };
  totalSteps: number;
  totalDistanceKm: number;
  totalMoveMinutes: number;
  totalHeartPoints: number;
  totalCalories: number;
  averageStepsPerActiveDay: number;
  stepGoal: number;
  goalDays: number;
  tenKDays: number;
  goalStreak?: { days: number; startDate: string; endDate: string };
  bestDay?: GoogleFitDay;
  untrackedDays: number;
  longestGap?: { days: number; startDate: string; endDate: string };
  lastTrackedDate?: string;
  byYear: GoogleFitPeriod[];
  byMonth: GoogleFitPeriod[];
  byWeekday: GoogleRankedItem[];
  byHour: GoogleRankedItem[];
  topDays: GoogleFitDay[];
  dailySource: "aggregate" | "intervals";
  rawDataFiles: number;
};

export type GoogleMailSender = {
  address: string;
  name?: string;
  domain: string;
  count: number;
  bytes: number;
  firstDate?: string;
  lastDate?: string;
  opened: number;
  unread: number;
  kind: "personal" | "automated";
  subscription: boolean;
  ignored: boolean;
};

export type GoogleMailDomain = {
  domain: string;
  count: number;
  bytes: number;
  senders: number;
  firstDate?: string;
  lastDate?: string;
  kind: "personal" | "automated";
};

export type GoogleMailSpike = {
  month: string;
  count: number;
  topSender?: string;
  topSenderCount?: number;
};

export type GoogleMailAttachmentType = {
  extension: string;
  count: number;
  bytes: number;
};

export type GoogleMailLargeMessage = {
  sender: string;
  name?: string;
  date?: string;
  bytes: number;
  attachments: number;
  subject?: string;
};

export type GoogleMailMerchant = {
  domain: string;
  name?: string;
  count: number;
  shipping: number;
  firstDate?: string;
  lastDate?: string;
  activeMonths: number;
  peakMonth?: string;
  peakCount?: number;
};

export type GoogleMailPurchaseMonth = {
  label: string;
  total: number;
  byMerchant: Record<string, number>;
};

export type GoogleMailSpendMerchant = {
  domain: string;
  name?: string;
  orders: number;
  total: number;
  average: number;
  first?: string;
  last?: string;
};

export type GoogleMailRepeatCharge = {
  domain: string;
  name?: string;
  amount: number;
  /** Different months in which the same amount was charged. */
  months: number;
  first?: string;
  last?: string;
};

// Built only when the user opts in to reading the text of order and receipt emails; nothing from the text is kept except these totals.
export type GoogleMailSpend = {
  /** Order and receipt emails whose text was opened. */
  scanned: number;
  /** Of those, how many had readable text. */
  readable: number;
  /** Orders with a total found, after the same order seen in several emails is counted once. */
  orders: number;
  duplicates: number;
  /** Orders with a total but no recognisable currency; left out of the sums. */
  noCurrency: number;
  currencies: { currency: string; orders: number; total: number }[];
  /** The currency the sums, charts, and rows below are in (the one with the most orders). */
  currency?: string;
  total: number;
  average: number;
  biggest?: { domain: string; name?: string; date?: string; amount: number };
  byMonth: GoogleRankedItem[];
  byYear: GoogleRankedItem[];
  merchants: GoogleMailSpendMerchant[];
  merchantCount: number;
  repeating: GoogleMailRepeatCharge[];
};

export type GoogleMailSummary = {
  parsedFiles: number;
  malformedFiles: number;
  warnings: string[];
  mboxFiles: number;
  duplicatesSkipped: number;
  messages: number;
  threads: number;
  totalBytes: number;
  account?: string;
  dateRange?: { start: string; end: string };
  undated: number;
  sent: number;
  received: number;
  unread: number;
  opened: number;
  hasOpenedData: boolean;
  automated: number;
  personal: number;
  withAttachments: number;
  unsubscribeMessages: number;
  subscriptionSenders: number;
  ignoredSubscriptionSenders: number;
  ignoredSubscriptionMessages: number;
  ignoredSubscriptionBytes: number;
  uniqueSenders: number;
  uniqueDomains: number;
  byYear: GoogleRankedItem[];
  byMonth: GoogleRankedItem[];
  byWeekday: GoogleRankedItem[];
  byHour: GoogleRankedItem[];
  /** Every day with at least one item, oldest first. */
  daily: GoogleDayCount[];
  busiestDay?: GoogleDayCount;
  spikes: GoogleMailSpike[];
  labels: GoogleRankedItem[];
  userLabels: GoogleRankedItem[];
  topSenders: GoogleMailSender[];
  topDomains: GoogleMailDomain[];
  topDomainsBySize: GoogleMailDomain[];
  subscriptions: GoogleMailSender[];
  footprint: {
    accountDomains: number;
    quietMonths: number;
    newDomainsByYear: GoogleRankedItem[];
    oldest: GoogleMailDomain[];
    quiet: GoogleMailDomain[];
  };
  settings?: { filters: number; blockedAddresses: number; forwardingAddresses: number };
  storage: {
    attachmentCount: number;
    attachmentBytes: number;
    attachmentShare: number;
    byType: GoogleMailAttachmentType[];
    largest: GoogleMailLargeMessage[];
  };
  /** Present only after the opt-in pass that reads order emails' text. */
  spend?: GoogleMailSpend;
  purchases: {
    messages: number;
    labelled: number;
    subjectOnly: number;
    shipping: number;
    merchantCount: number;
    merchants: GoogleMailMerchant[];
    stackMerchants: string[];
    months: GoogleMailPurchaseMonth[];
  };
  security: {
    messages: number;
    byKind: GoogleRankedItem[];
    byMonth: GoogleRankedItem[];
    topSources: GoogleRankedItem[];
    passwordServices: number;
    firstDate?: string;
    lastDate?: string;
  };
};

export type GoogleGeminiExchange = {
  id: string;
  time?: string;
  prompt: string;
  response?: string;
  promptChars: number;
  responseChars: number;
  images: number;
  attachments: string[];
  truncated: boolean;
};

export type GoogleGeminiConversation = {
  id: string;
  firstTime?: string;
  lastTime?: string;
  images: number;
  attachmentCount: number;
  exchanges: GoogleGeminiExchange[];
};

export type GoogleGeminiSummary = {
  prompts: number;
  conversations: number;
  withResponse: number;
  images: number;
  attachedFiles: number;
  otherEntries: number;
  parsedFiles: number;
  malformedEntries: number;
  warnings: string[];
  dateRange?: { start?: string; end?: string };
  byMonth: GoogleRankedItem[];
  byHour: GoogleRankedItem[];
  byWeekday: GoogleRankedItem[];
  /** Every day with at least one item, oldest first. */
  daily: GoogleDayCount[];
  busiestDay?: GoogleDayCount;
  promptLengths: GoogleRankedItem[];
  medianPromptChars: number;
  longestPromptChars: number;
  longestConversationPrompts: number;
  attachmentTypes: GoogleRankedItem[];
  folderFiles: { count: number; bytes: number };
  conversationList: GoogleGeminiConversation[];
  conversationLimit: number;
  isConversationListCapped: boolean;
};

export type GooglePlayGameAchievement = {
  name: string;
  state: string;
  xp: number;
  date?: string;
};

export type GooglePlayGameScore = {
  leaderboard: string;
  score: string;
  date?: string;
};

export type GooglePlayGame = {
  id: string;
  title: string;
  firstPlayed?: string;
  lastPlayed?: string;
  unlocked: number;
  achievementTotal: number;
  xp: number;
  scoreCount: number;
  cloudSaves: number;
  playtimeMinutes: number;
  sessions: number;
  achievements: GooglePlayGameAchievement[];
  scores: GooglePlayGameScore[];
};

export type GooglePlayGamesSummary = {
  games: number;
  gamesWithAchievements: number;
  unlockedAchievements: number;
  achievementRows: number;
  scoreRows: number;
  xpEvents: number;
  cloudSaves: number;
  parsedFiles: number;
  warnings: string[];
  profile?: {
    visibility?: string;
    gamerId?: string;
    level?: number;
    xp?: number;
    unlockedFromProfile?: number;
    categoryMostXp?: string;
    lastLevelledUp?: string;
    lastGame?: string;
    lastGameDate?: string;
    followers: number;
    following: number;
  };
  playtime?: {
    totalMinutes: number;
    sessions: number;
    activeDays: number;
    packages: number;
    dateRange?: { start?: string; end?: string };
    byMonth: GoogleRankedItem[];
    byWeekday: GoogleRankedItem[];
    byGame: GoogleRankedItem[];
    longestDay?: { date: string; minutes: number };
  };
  streaks?: {
    longest: number;
    current: number;
    days: number;
    firstDate?: string;
    lastDate?: string;
    mostPlayed: GoogleRankedItem[];
  };
  xpTimeline: GoogleRankedItem[];
  topByAchievements: GoogleRankedItem[];
  topByXp: GoogleRankedItem[];
  gameList: GooglePlayGame[];
  gameLimit: number;
  isGameListCapped: boolean;
};

export type GoogleDriveCategory = {
  key: string;
  label: string;
  files: number;
  bytes: number;
};

export type GoogleDriveType = {
  extension: string;
  files: number;
  bytes: number;
};

export type GoogleDriveFolder = {
  /** Folder path inside Drive, or an empty string for files that sit at the top level. */
  path: string;
  files: number;
  bytes: number;
};

export type GoogleDriveFile = {
  /** Path inside the Drive folder, including the file name. */
  path: string;
  name: string;
  folder: string;
  extension: string;
  category: string;
  bytes: number;
  modified?: string;
  archive: boolean;
};

// Built only from the ZIP index (names, sizes, and modified dates); no Drive file is opened or inflated.
export type GoogleDriveSummary = {
  files: number;
  folders: number;
  totalBytes: number;
  dateRange?: { start: string; end: string };
  byCategory: GoogleDriveCategory[];
  byType: GoogleDriveType[];
  byYear: GoogleRankedItem[];
  byFolder: GoogleDriveFolder[];
  archives: { files: number; bytes: number };
  largestFiles: GoogleDriveFile[];
  largestLimit: number;
  isLargestCapped: boolean;
};

// The slow sections can be read after the dashboard is already showing (see platforms/google/sections.ts).
export type GoogleSectionKey = "photos" | "mail" | "fit";

export type GoogleSectionStatus =
  | { status: "pending" }
  | { status: "running"; label: string; percent: number }
  | { status: "done" }
  | { status: "failed"; message: string };

export type GoogleSectionResult = {
  key: GoogleSectionKey;
  photos?: GooglePhotosSummary;
  mail?: GoogleMailSummary;
  fit?: GoogleFitSummary;
  /** Files the section could not read; the core pass counted them as parsed. */
  malformed: { path: string; reason: string }[];
};

export type GoogleUnpackedData = {
  generatedAt: string;
  summary: {
    archiveCount: number;
    entryCount: number;
    productCount: number;
    selectedSize: number;
    compressedSize: number;
    uncompressedSize: number;
    parsed: number;
    deferred: number;
    skipped: number;
    malformed: number;
    unsupported: number;
  };
  archives: GoogleArchiveSummary[];
  products: GoogleProductSummary[];
  largestFiles: GoogleLargestFile[];
  services: GoogleServiceAvailability[];
  warnings: string[];
  activity?: GoogleActivitySummary;
  chromeHistory?: GoogleChromeHistorySummary;
  photos?: GooglePhotosSummary;
  playStore?: GooglePlaySummary;
  moreServices?: GoogleMoreServices;
  fit?: GoogleFitSummary;
  mail?: GoogleMailSummary;
  gemini?: GoogleGeminiSummary;
  playGames?: GooglePlayGamesSummary;
  drive?: GoogleDriveSummary;
  /** Sections still being read in the background; each is removed from this list as its result arrives. */
  pending?: GoogleSectionKey[];
  youtube?: YouTubeUnpackedData;
};
