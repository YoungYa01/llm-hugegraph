import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.jsx";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/semi-overrides.css";

createRoot(document.querySelector("#app")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
