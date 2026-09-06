; Tauri NSIS 安装器钩子（tauri.conf.json bundle.windows.nsis.installerHooks 引用）
; 卸载时清理开机自启写下的注册表残留（ADR-0015）。
; 注意：值名必须与 autostart.rs 写入的一致（取自 tauri.conf.json 的 productName）；
; Run 键为全系统共享，只删本程序的值，绝不能删除键本身。
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Usage Tracker"
!macroend
