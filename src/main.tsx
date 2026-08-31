import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, initThemeSync } from "./lib/theme";
import { LanguageProvider } from "./i18n";
import "./styles.css";

applyTheme();
// 主窗口 / 快速面板共用此入口：各自监听跨窗口主题广播
void initThemeSync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
