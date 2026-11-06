; DonDownload installer baseline: force a per-user installation.
;
; electron-builder's assisted installer normally shows an install-mode page
; that lets an administrator choose a per-machine installation. DonDownload's
; baseline is explicitly per-user and must not write machine-wide state or
; request elevation, so this macro selects the current-user mode and aborts the
; page before it is displayed.
;
; This file is referenced from electron-builder.yml (nsis.include) and is not a
; runtime application asset.

!macro customInstallMode
  StrCpy $isForceMachineInstall "0"
  StrCpy $isForceCurrentInstall "1"
!macroend

; Uninstall cleanup: the app removes its current-user native messaging manifest
; and the Chrome/Helium and Edge registry keys, but only when that manifest
; points inside this installation. ExecWait keeps the uninstaller from deleting
; the executable while cleanup is still running. A dev registration pointing at
; a repository is intentionally left alone.
!macro customUnInstall
  ; An upgrade runs the old uninstaller first. Keep the browser connection in
  ; that case; the new version re-registers itself on its next start anyway.
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\DonDownload.exe"
      ExecWait '"$INSTDIR\DonDownload.exe" --unregister-native-host'
    ${endIf}
  ${endIf}
!macroend
