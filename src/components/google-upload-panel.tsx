import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Database,
  FileArchive,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { GoogleDashboard, type MailBodiesControl, type SectionsControl } from "@/components/google-dashboard";
import { googleDemoData } from "@/platforms/google/demo-data";
import GoogleParserWorker from "@/platforms/google/parser-worker.ts?worker";
import type { GoogleWorkerMessage, GoogleWorkerRequest } from "@/platforms/google/parser-worker";
import type { GoogleSectionEntries } from "@/platforms/google/parser/parse-google-takeout";
import { applyGoogleSection } from "@/platforms/google/sections";
import type {
  GoogleParserError,
  GoogleParserProgress,
  GoogleSectionKey,
  GoogleSectionStatus,
  GoogleUnpackedData,
} from "@/platforms/google/types";

type UploadState =
  | { status: "idle" }
  | { status: "parsing"; fileName: string; progress: GoogleParserProgress }
  | { status: "ready"; result: GoogleUnpackedData }
  | { status: "failed"; error: GoogleParserError };

function toFiles(fileList?: FileList | null): File[] {
  return fileList ? Array.from(fileList) : [];
}

export function GoogleUploadPanel() {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [isDragging, setIsDragging] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const filesRef = useRef<File[]>([]);
  const sectionWorkersRef = useRef<Map<GoogleSectionKey, Worker>>(new Map());
  const sectionEntriesRef = useRef<GoogleSectionEntries>({});
  const [sectionStatus, setSectionStatus] = useState<Partial<Record<GoogleSectionKey, GoogleSectionStatus>>>({});
  const [mailBodies, setMailBodies] = useState<{ status: "idle" | "running" | "failed"; label: string; percent: number; error?: string }>({
    status: "idle",
    label: "",
    percent: 0,
  });

  const progress = state.status === "parsing" ? state.progress.percent : state.status === "ready" ? 100 : 0;

  useEffect(() => {
    const sectionWorkers = sectionWorkersRef.current;
    return () => {
      workerRef.current?.terminate();
      for (const worker of sectionWorkers.values()) worker.terminate();
    };
  }, []);

  function stopSections() {
    for (const worker of sectionWorkersRef.current.values()) worker.terminate();
    sectionWorkersRef.current.clear();
    sectionEntriesRef.current = {};
    setSectionStatus({});
  }

  function startSection(key: GoogleSectionKey) {
    const entries = sectionEntriesRef.current[key];
    if (!entries) return;

    sectionWorkersRef.current.get(key)?.terminate();
    const worker = new GoogleParserWorker();
    sectionWorkersRef.current.set(key, worker);
    setSectionStatus((prev) => ({ ...prev, [key]: { status: "running", label: "Starting", percent: 0 } }));

    const finish = (status: GoogleSectionStatus) => {
      setSectionStatus((prev) => ({ ...prev, [key]: status }));
      worker.terminate();
      if (sectionWorkersRef.current.get(key) === worker) sectionWorkersRef.current.delete(key);
    };

    worker.onmessage = (event: MessageEvent<GoogleWorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        setSectionStatus((prev) => {
          const current = prev[key];
          const percent = Math.max(current?.status === "running" ? current.percent : 0, message.progress.percent);
          return current?.status === "done" ? prev : { ...prev, [key]: { status: "running", label: message.progress.label, percent } };
        });
        return;
      }
      if (message.type === "section-done") {
        setState((prev) => (prev.status === "ready" ? { status: "ready", result: applyGoogleSection(prev.result, message.result) } : prev));
        finish({ status: "done" });
        return;
      }
      if (message.type === "error") finish({ status: "failed", message: message.error.message });
    };

    worker.onerror = () => finish({ status: "failed", message: "This section could not be read in the browser." });
    worker.postMessage({ task: "section", section: key, entries } satisfies GoogleWorkerRequest);
  }

  function startSections(sectionEntries: GoogleSectionEntries) {
    stopSections();
    sectionEntriesRef.current = sectionEntries;
    const keys = (Object.keys(sectionEntries) as GoogleSectionKey[]).filter((key) => sectionEntries[key]?.length);
    setSectionStatus(Object.fromEntries(keys.map((key) => [key, { status: "pending" } satisfies GoogleSectionStatus])));
    for (const key of keys) startSection(key);
  }

  function resetToUploader() {
    workerRef.current?.terminate();
    workerRef.current = null;
    stopSections();
    filesRef.current = [];
    setMailBodies({ status: "idle", label: "", percent: 0 });
    setState({ status: "idle" });
    setPrivacyMode(false);
  }

  function readMailBodies() {
    const files = filesRef.current;
    if (!files.length || mailBodies.status === "running") return;

    workerRef.current?.terminate();
    const worker = new GoogleParserWorker();
    workerRef.current = worker;
    setMailBodies({ status: "running", label: "Reading order emails", percent: 2 });

    const finish = (next: { status: "idle" | "failed"; error?: string }) => {
      setMailBodies({ status: next.status, label: "", percent: 0, error: next.error });
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.onmessage = (event: MessageEvent<GoogleWorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        setMailBodies((prev) =>
          prev.status === "running" ? { status: "running", label: message.progress.label, percent: Math.max(prev.percent, message.progress.percent) } : prev,
        );
        return;
      }
      if (message.type === "mail-done") {
        if (!message.mail?.spend) {
          finish({ status: "failed", error: "No mailbox could be read this time." });
          return;
        }
        setState((prev) => (prev.status === "ready" ? { status: "ready", result: { ...prev.result, mail: message.mail } } : prev));
        finish({ status: "idle" });
        return;
      }
      if (message.type === "error") finish({ status: "failed", error: message.error.message });
    };

    worker.onerror = () => finish({ status: "failed", error: "The order emails could not be read in the browser." });
    worker.postMessage({ files, task: "mail-bodies" } satisfies GoogleWorkerRequest);
  }

  function parseFiles(files: File[]) {
    if (!files.length) return;

    workerRef.current?.terminate();
    stopSections();
    filesRef.current = files;
    setMailBodies({ status: "idle", label: "", percent: 0 });

    const fileName = files.length === 1 ? files[0].name : `${files.length} files`;
    setState({
      status: "parsing",
      fileName,
      progress: { stage: "reading", label: "Reading Google Takeout ZIPs", percent: 1 },
    });

    const worker = new GoogleParserWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<GoogleWorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        setState((prev) =>
          prev.status === "parsing"
            ? { status: "parsing", fileName: prev.fileName, progress: { ...message.progress, percent: Math.max(prev.progress.percent, message.progress.percent) } }
            : prev,
        );
        return;
      }

      if (message.type === "done") {
        setState({ status: "ready", result: message.result });
        if (message.sectionEntries) startSections(message.sectionEntries);
      } else if (message.type === "error") {
        setState({ status: "failed", error: message.error });
      }

      worker.terminate();
      workerRef.current = null;
    };

    worker.onerror = () => {
      setState({ status: "failed", error: { fileName, message: "The Google Takeout export could not be parsed in the browser." } });
      worker.terminate();
      workerRef.current = null;
    };

    worker.postMessage({ files, deferSections: true } satisfies GoogleWorkerRequest);
  }

  if (state.status === "ready") {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-[#0d0f14]">
        <div className="sticky top-0 z-30 border-b border-white/10 bg-[#0d0f14]/95 px-5 py-2.5 backdrop-blur">
          <Button type="button" variant="outline" className="h-9 border-white/15 bg-[#15171b] px-3 text-sm text-white hover:bg-white/10" onClick={resetToUploader}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to uploader
          </Button>
        </div>
        <GoogleDashboard
          data={state.result}
          privacyMode={privacyMode}
          mailBodies={{ ...mailBodies, onStart: readMailBodies } satisfies MailBodiesControl}
          sections={Object.keys(sectionStatus).length ? ({ status: sectionStatus, onRetry: startSection } satisfies SectionsControl) : undefined}
          onPrivacyModeChange={setPrivacyMode}
        />
      </div>
    );
  }

  return (
    <main className="min-h-screen px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-[#34a853]/30 bg-[#34a853]/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[#b8f3c9]">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Browser viewer
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-tight sm:text-6xl">Google Takeout Viewer</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">
              Select the ZIP parts from one Google Takeout export. The app indexes large archives in the browser and opens supported structured files in background workers.
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-white/10 bg-[#15171b] shadow-2xl shadow-black/25">
          <div className="flex items-center justify-between border-b border-white/10 bg-[#0d0f14] px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-white text-[#4285f4]">
                <Database className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-white">Takeout indexer</h2>
                <p className="truncate text-xs text-white/55">multi-part ZIPs, coverage, and service dashboards</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-md bg-[#34a853]/15 px-2.5 py-1 text-xs font-medium text-[#b8f3c9]">
              <ShieldCheck className="size-3" aria-hidden="true" />
              browser
            </span>
          </div>

          <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)] lg:p-5">
            <div className="grid grid-cols-1 gap-3">
              <label
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  parseFiles(toFiles(event.dataTransfer.files));
                }}
                className={`flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center transition ${
                  isDragging ? "border-[#4285f4] bg-[#4285f4]/10" : "border-white/15 bg-[#0d0f14] hover:border-[#4285f4]/70 hover:bg-white/[0.03]"
                }`}
              >
                <input type="file" accept=".zip" multiple className="sr-only" onChange={(event) => parseFiles(toFiles(event.target.files))} />
                <span className="mb-4 flex size-14 items-center justify-center rounded-lg bg-white text-[#4285f4] shadow-lg shadow-[#4285f4]/10">
                  <UploadCloud className="size-7" aria-hidden="true" />
                </span>
                <span className="text-xl font-semibold tracking-tight text-white">Drop your Google Takeout ZIPs</span>
                <span className="mt-2 max-w-md text-sm leading-6 text-white/60">
                  Select every ZIP part from the same Takeout request. For large exports, the dashboard opens after the fast core pass while Photos, Gmail, and Fit continue locally in the background.
                </span>
                <span className="mt-5 inline-flex items-center gap-2 rounded-md bg-[#4285f4] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2f6fdd]">
                  <FolderOpen className="size-4" aria-hidden="true" />
                  Choose ZIP files
                </span>
              </label>

              <Button
                type="button"
                variant="outline"
                className="justify-self-center border-white/15 bg-[#0d0f14] text-white hover:bg-white/10"
                onClick={() => setState({ status: "ready", result: googleDemoData })}
              >
                <Sparkles className="size-4" aria-hidden="true" />
                View demo
              </Button>
            </div>

            <div className="space-y-3">
              <div className="rounded-lg border border-white/10 bg-[#0d0f14] p-4">
                <div className="flex items-start gap-3">
                  <FileArchive className="mt-0.5 size-5 shrink-0 text-[#fbbc04]" aria-hidden="true" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">Built for huge exports</h3>
                    <p className="mt-1 text-sm leading-6 text-white/60">
                      ZIPs are indexed from their central directory. Photos media stays zipped, Drive is summarised from the file list alone, and Gmail headers are streamed without keeping message bodies.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-[#0d0f14] p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#34a853]" aria-hidden="true" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">Selective reading</h3>
                    <p className="mt-1 text-sm leading-6 text-white/60">
                      The parser works from the ZIP file list first, then reads each supported service only when that section needs it.
                    </p>
                  </div>
                </div>
              </div>

              {state.status === "parsing" ? (
                <div className="rounded-lg border border-[#4285f4]/30 bg-[#4285f4]/10 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#c8dcff]">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {state.progress.label}
                  </div>
                  <Progress value={progress} className="mt-3 h-2" />
                  <p className="mt-2 text-xs text-[#c8dcff]/75">{state.fileName}</p>
                </div>
              ) : null}

              {state.status === "failed" ? (
                <div className="rounded-lg border border-[#ea4335]/30 bg-[#ea4335]/10 p-4 text-sm leading-6 text-[#ffb7ae]">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-1 size-4 shrink-0" aria-hidden="true" />
                    <p>
                      <strong>{state.error.fileName ?? "Could not parse export"}:</strong> {state.error.message}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
