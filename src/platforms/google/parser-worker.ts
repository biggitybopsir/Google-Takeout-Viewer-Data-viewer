import { parseGoogleSection, parseGoogleTakeoutCore, type GoogleSectionEntries } from "@/platforms/google/parser/parse-google-takeout";
import { deviceLog, heapMegabytes } from "@/lib/dev-device-log";
import { parseMailWithBodies } from "@/platforms/google/parser/mail";
import type { GoogleZipEntry } from "@/platforms/google/parser/archive-index";
import type { GoogleMailSummary, GoogleParserError, GoogleParserProgress, GoogleSectionKey, GoogleSectionResult, GoogleUnpackedData } from "@/platforms/google/types";

// task "parse" reads the ZIPs (with deferSections it leaves Photos, Gmail, and Fit for later and hands back the entries
// they need), "section" reads one of those later, and "mail-bodies" is the opt-in pass that also reads order emails' text.
export type GoogleWorkerRequest =
  | { task?: "parse" | "mail-bodies"; files: File[]; deferSections?: boolean }
  | { task: "section"; section: GoogleSectionKey; entries: GoogleZipEntry[] };

export type GoogleWorkerMessage =
  | { type: "progress"; progress: GoogleParserProgress }
  | { type: "done"; result: GoogleUnpackedData; sectionEntries?: GoogleSectionEntries }
  | { type: "section-done"; result: GoogleSectionResult }
  | { type: "mail-done"; mail: GoogleMailSummary | undefined }
  | { type: "error"; error: GoogleParserError };

type WorkerScope = {
  onmessage: ((event: MessageEvent<GoogleWorkerRequest>) => void) | null;
  postMessage: (message: GoogleWorkerMessage) => void;
};

const scope = self as unknown as WorkerScope;

// Development only (a no-op in production builds): report the worker's own memory, which the page cannot see.
let lastLoggedAt = 0;
let lastLoggedStage = "";
function reportProgress(progress: GoogleParserProgress) {
  scope.postMessage({ type: "progress", progress });
  const now = Date.now();
  // Every indexing step is logged (there is one per ZIP), the rest at most every couple of seconds.
  if (progress.stage !== lastLoggedStage || progress.stage === "indexing" || now - lastLoggedAt > 2000) {
    lastLoggedStage = progress.stage;
    lastLoggedAt = now;
    deviceLog("worker-progress", { stage: progress.stage, label: progress.label.slice(0, 60), percent: Math.round(progress.percent), workerHeapMb: heapMegabytes() });
  }
}

scope.onmessage = async (event) => {
  const request = event.data;
  deviceLog("worker-received", { task: request.task ?? "parse", files: "files" in request ? request.files.length : undefined, section: "section" in request ? request.section : undefined, workerHeapMb: heapMegabytes() });
  try {
    if (request.task === "section") {
      const result = await parseGoogleSection(request.section, request.entries, reportProgress);
      scope.postMessage({ type: "section-done", result });
      deviceLog("worker-section-done", { section: request.section, workerHeapMb: heapMegabytes() });
      return;
    }
    if (request.task === "mail-bodies") {
      const mail = await parseMailWithBodies(request.files, reportProgress);
      scope.postMessage({ type: "mail-done", mail });
      deviceLog("worker-mail-bodies-done", { orders: mail?.spend?.orders, workerHeapMb: heapMegabytes() });
      return;
    }
    const { data, sectionEntries } = await parseGoogleTakeoutCore(request.files, reportProgress, { deferSections: request.deferSections });
    scope.postMessage({ type: "done", result: data, sectionEntries });
    deviceLog("worker-done", { workerHeapMb: heapMegabytes(), deferred: data.pending });
  } catch (error) {
    deviceLog("worker-error", { message: String((error as Error | undefined)?.message ?? error), workerHeapMb: heapMegabytes() });
    scope.postMessage({
      type: "error",
      error:
        typeof error === "object" && error && "message" in error
          ? (error as GoogleParserError)
          : { fileName: "files" in request ? request.files[0]?.name : undefined, message: "The Google Takeout export could not be parsed." },
    });
  }
};
