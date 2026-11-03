import { KoreProvider } from "@qarasky/kore-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Link } from "wouter";
import { App } from "./App";
import { SessionProvider } from "./lib/session";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <KoreProvider linkComponent={Link}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </KoreProvider>
  </StrictMode>,
);
