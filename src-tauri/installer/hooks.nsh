; 安装程序的额外步骤(由 tauri.conf.json 的 installerHooks 引用)。
;
; 背景:Windows 会按"快捷方式的路径"缓存图标。升级安装后,程序文件里的图标已经换了,
; 但桌面上沿用的旧快捷方式、开始菜单里的旧快捷方式,仍然显示缓存里的旧图。
; 另外安装程序默认不会改动已有的桌面快捷方式(只有勾选"创建桌面快捷方式"才重建)。

!macro NSIS_HOOK_POSTINSTALL
  ; 桌面上已经有本程序的快捷方式:重建它,并显式指定图标来源,不再依赖旧快捷方式里缓存的图标
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +3
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ; 开始菜单同理
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +3
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"

  ; 通知系统"图标已变化",让资源管理器立刻重画桌面和开始菜单里的图标(SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
