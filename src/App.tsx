import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QuickWindow } from "./views/QuickWindow";
import { GlanceWindow } from "./views/GlanceWindow";
import { MainWindow } from "./views/MainWindow";

export default function App() {
  const [windowLabel, setWindowLabel] = useState<string | null>(null);

  useEffect(() => {
    setWindowLabel(getCurrentWindow().label);
  }, []);

  if (!windowLabel) return null;
  if (windowLabel === "quick") return <QuickWindow />;
  if (windowLabel === "glance") return <GlanceWindow />;
  return <MainWindow />;
}
