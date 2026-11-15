; SHCTX follows Tauri's per-user / per-machine installation scope.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Pigry" "" "Open with Pigry"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Pigry" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Pigry\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open-folder $\"%1\.$\"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Pigry" "" "Open with Pigry"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Pigry" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Pigry\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open-folder $\"%V\.$\"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Pigry"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Pigry"
!macroend
