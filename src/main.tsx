import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useApp } from "./state/store";
import "./app.css";

if (import.meta.env.DEV) {
  // dev console access to the store, for debugging and scripted verification
  (window as unknown as Record<string, unknown>).__asbuilt = useApp;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
