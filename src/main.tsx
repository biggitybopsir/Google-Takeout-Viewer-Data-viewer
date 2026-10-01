import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleUploadPanel } from "@/components/google-upload-panel";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GoogleUploadPanel />
  </StrictMode>,
);
