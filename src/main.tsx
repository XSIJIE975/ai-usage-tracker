import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { applyTheme, initThemeSync } from "./lib/theme";
import { LanguageProvider } from "./i18n";
import "./styles.css";

applyTheme();
// 主窗口 / 快速面板共用此入口：各自监听跨窗口主题广播
void initThemeSync();

// release 加固（ADR-0026）前端层：禁页面重载/开发者工具快捷键、右键菜单与拖放导航。
// Windows 的 WebView2 设置层已在 Rust 端权威关闭；这里兜底其余路径并覆盖
// macOS/Linux 的默认右键菜单。dev 构建不注入，保留 HMR 与调试入口。
if (import.meta.env.PROD && isTauri()) {
  window.addEventListener(
    "keydown",
    (event) => {
      const { key, ctrlKey, metaKey, shiftKey, altKey } = event;
      const reload = key === "F5" || ((ctrlKey || metaKey) && !shiftKey && !altKey && key.toLowerCase() === "r");
      const devtools =
        key === "F12" ||
        (ctrlKey && shiftKey && key.toLowerCase() === "i") ||
        (metaKey && altKey && key.toLowerCase() === "i");
      if (reload || devtools) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  for (const type of ["contextmenu", "dragover", "drop"] as const) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
