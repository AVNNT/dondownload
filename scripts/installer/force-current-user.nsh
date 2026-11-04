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
