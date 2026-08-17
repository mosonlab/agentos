import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { LocaleProvider } from "./lib/i18n";
import { ThemeProvider } from "./lib/theme";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    {/* Beside ThemeProvider, not inside App: the two stores mirror each other in
        every other respect, and mounting here also covers App's own banners. */}
    <ThemeProvider><LocaleProvider><App /></LocaleProvider></ThemeProvider>
  </StrictMode>,
);
