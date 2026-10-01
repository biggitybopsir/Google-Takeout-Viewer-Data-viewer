import type {
  GoogleCoverageStatus,
  GoogleFitSummary,
  GoogleMailSummary,
  GooglePhotosSummary,
  GoogleSectionKey,
  GoogleSectionResult,
  GoogleServiceAvailability,
  GoogleUnpackedData,
} from "@/platforms/google/types";

// Everything here is shared by the core parse (which defers the slow sections) and the page that merges them back in,
// so it holds no parsing code and stays out of the way of the main-thread bundle.

/** The slow sections that can be read in the background after the dashboard is already showing. */
export const DEFERRABLE_SECTIONS: { key: GoogleSectionKey; product: string; label: string }[] = [
  { key: "photos", product: "Google Photos", label: "Google Photos metadata" },
  { key: "mail", product: "Mail", label: "Gmail" },
  { key: "fit", product: "Fit", label: "Fit" },
];

export const SERVICE_LABELS: Record<string, string> = {
  activity: "My Activity",
  chrome: "Chrome History",
  youtube: "YouTube",
  photos: "Google Photos metadata",
  fit: "Fit",
  maps: "Maps and Timeline",
  play: "Google Play Store",
  mail: "Gmail",
  gemini: "Gemini",
  games: "Play Games",
  drive: "Drive",
  contacts: "Contacts",
  calendar: "Calendar",
  tasks: "Tasks",
  chat: "Google Chat",
};

const LOADING_NOTE = "Loading in the background; this card updates when it is done.";

export function photosServiceCard(files: number, photos: GooglePhotosSummary | undefined, loading: boolean): GoogleServiceAvailability {
  return {
    key: "photos",
    label: SERVICE_LABELS.photos,
    status: loading ? "available" : photos?.parsedFiles ? "parsed" : files ? "deferred" : "missing",
    files,
    note: loading ? LOADING_NOTE : photos?.parsedFiles ? "Sidecar metadata parsed; photo and video files stay zipped and unread." : "Media remains deferred; sidecar metadata can be parsed when present.",
  };
}

export function fitServiceCard(files: number, fit: GoogleFitSummary | undefined, loading: boolean): GoogleServiceAvailability {
  return {
    key: "fit",
    label: SERVICE_LABELS.fit,
    status: loading ? "available" : fit?.parsedFiles ? "parsed" : files ? "available" : "missing",
    files,
    note: loading ? LOADING_NOTE : fit?.parsedFiles ? "Daily steps, distance, and active minutes parsed; raw data point files stay unread." : "Daily activity metrics can become a tab when present.",
  };
}

export function mailServiceCard(files: number, mail: GoogleMailSummary | undefined, loading: boolean): GoogleServiceAvailability {
  return {
    key: "mail",
    label: SERVICE_LABELS.mail,
    status: loading ? "available" : mail?.parsedFiles ? "parsed" : files ? "deferred" : "missing",
    files,
    note: loading ? LOADING_NOTE : mail?.parsedFiles ? "Mailbox headers scanned for senders, timing, and subscriptions; message text is read only if you opt in to order totals." : "Mbox content is deferred.",
  };
}

function productOfPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const takeout = parts.findIndex((part) => part.toLowerCase() === "takeout");
  return (takeout >= 0 ? parts[takeout + 1] : parts[0]) ?? "Unknown";
}

function productStatus(product: { parsed: number; deferred: number; malformed: number; unsupported: number }): GoogleCoverageStatus {
  if (product.parsed > 0) return "parsed";
  if (product.unsupported > 0) return "unsupported";
  if (product.malformed > 0) return "malformed";
  if (product.deferred > 0) return "deferred";
  return "indexed";
}

/** Merges one finished background section into the data that is already on screen, without touching anything else. */
export function applyGoogleSection(data: GoogleUnpackedData, result: GoogleSectionResult): GoogleUnpackedData {
  const summary = result[result.key];
  const existingCard = data.services.find((service) => service.key === result.key);
  const files = existingCard?.files ?? 0;
  const card =
    result.key === "photos"
      ? photosServiceCard(files, result.photos, false)
      : result.key === "mail"
        ? mailServiceCard(files, result.mail, false)
        : fitServiceCard(files, result.fit, false);

  // The core pass counted these files as parsed (that is how they are classified up front); files the section could not read move to malformed.
  const malformedPaths = new Set(result.malformed.map((item) => item.path));
  const products = data.products.map((product) => ({ ...product }));
  for (const item of result.malformed) {
    const product = products.find((row) => row.product === productOfPath(item.path));
    if (!product || product.parsed === 0) continue;
    product.parsed -= 1;
    product.malformed += 1;
    product.serviceStatus = productStatus(product);
  }

  const warnings = (summary as { warnings?: string[] } | undefined)?.warnings ?? [];
  return {
    ...data,
    [result.key]: summary,
    pending: (data.pending ?? []).filter((key) => key !== result.key),
    services: data.services.map((service) => (service.key === result.key ? card : service)),
    products,
    summary: {
      ...data.summary,
      parsed: data.summary.parsed - malformedPaths.size,
      malformed: data.summary.malformed + malformedPaths.size,
    },
    largestFiles: data.largestFiles.map((file) => {
      const failure = result.malformed.find((item) => item.path === file.path);
      return failure ? { ...file, status: "malformed" as const, reason: failure.reason } : file;
    }),
    warnings: [...data.warnings, ...warnings],
  };
}
