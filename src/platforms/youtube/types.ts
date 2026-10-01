export type YouTubeParserStage = "reading" | "extracting" | "parsing" | "analyzing" | "complete";

export type YouTubeParserProgress = {
  stage: YouTubeParserStage;
  label: string;
  percent: number;
};

export type YouTubeParserError = {
  fileName?: string;
  message: string;
};

export type YouTubeRankedItem = {
  label: string;
  count: number;
  channelUrl?: string;
};

export type YouTubeDayCount = {
  date: string;
  count: number;
};

export type YouTubeCoverageWindow = {
  key: string;
  label: string;
  firstDate?: string;
  lastDate?: string;
};

export type YouTubeWatchEntry = {
  title?: string;
  videoUrl?: string;
  channelName?: string;
  channelUrl?: string;
  time?: string;
  isAd: boolean;
  isRemoved: boolean;
};

export type YouTubeSearchEntry = {
  query?: string;
  resultUrl?: string;
  time?: string;
};

export type YouTubeWatchSummary = {
  total: number;
  adViews: number;
  removedOrUnavailable: number;
  distinctChannels: number;
  busiestDay?: YouTubeDayCount;
  recent: YouTubeWatchEntry[];
};

export type YouTubeSearchSummary = {
  total: number;
  distinctQueries: number;
  busiestDay?: YouTubeDayCount;
  recent: YouTubeSearchEntry[];
};

export type YouTubeTopVideo = {
  title: string;
  count: number;
  videoUrl?: string;
  channelName?: string;
};

export type YouTubeStreak = {
  days: number;
  startDate: string;
  endDate: string;
};

export type YouTubeExportSectionStatus = "found" | "empty" | "missing";

export type YouTubeExportSection = {
  key: string;
  label: string;
  description: string;
  files: string[];
  rows: number;
  status: YouTubeExportSectionStatus;
};

export type YouTubeUnpackedData = {
  fileName: string;
  generatedAt: string;
  sourceFiles: string[];
  coverage: YouTubeCoverageWindow[];
  watch: YouTubeWatchSummary;
  search: YouTubeSearchSummary;
  topChannels: YouTubeRankedItem[];
  topSearchQueries: YouTubeRankedItem[];
  activityByDay: YouTubeDayCount[];
  activityByWeek: YouTubeRankedItem[];
  activityByMonth: YouTubeRankedItem[];
  activityByYear: YouTubeRankedItem[];
  activityByHour: YouTubeRankedItem[];
  activityByWeekday: YouTubeRankedItem[];
  topRewatchedVideos: YouTubeTopVideo[];
  longestActiveStreak?: YouTubeStreak;
  musicWatchShare: number;
  exportSections: YouTubeExportSection[];
  warnings: string[];
};
