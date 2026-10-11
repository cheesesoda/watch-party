import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { enableArrowNavigation, isTv } from "./device.ts";
import "./styles.css";

// TVs are read from across the room; scale the whole UI up so text is legible from the couch.
if (isTv()) {
  document.documentElement.style.setProperty("zoom", window.innerWidth >= 1600 ? "1.5" : "1.2");
  enableArrowNavigation();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
