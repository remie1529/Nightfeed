!macro customInstall
  ; Shortcuts the installer just created point at the exe icon. Retarget the
  ; ones that exist at resources\icon.ico so the desktop and taskbar show the logo.
  IfFileExists "$INSTDIR\resources\icon.ico" 0 nf_icon_done
    IfFileExists "$newDesktopLink" 0 nf_icon_skip_desktop
      CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    nf_icon_skip_desktop:
    IfFileExists "$newStartMenuLink" 0 nf_icon_skip_menu
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    nf_icon_skip_menu:
    IfFileExists "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" 0 nf_icon_skip_pin
      CreateShortCut "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    nf_icon_skip_pin:
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  nf_icon_done:
!macroend
