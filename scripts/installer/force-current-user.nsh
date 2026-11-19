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

; Update handshake with the browser extension helper.
;
; electron-builder's default CHECK_APP_RUNNING stops every process whose path
; is under $INSTDIR and then loops on that check. The browser extension helper,
; resources\native\dondownload-native-host.exe, is under $INSTDIR too: a browser
; starts it through native messaging and starts it again as soon as it exits,
; so the default loop never settles and the user sees "cannot be closed" for as
; long as the browser keeps asking. The installer writes
; resources\native\.updating before it stops anything; a helper that starts from
; then on exits immediately instead of being stopped and started again (see
; native/NativeHost.cs).
;
; Every match is also stopped again in customInstall, right before the files are
; written, to catch a helper the browser started before the marker took effect.
; The check below treats the extension helper as stopped while the marker that
; helper honours exists, and only asks the user about anything else that
; survives.
;
; The installer and the uninstaller are separate compilations of the same
; script, so this file only holds macros: macros come first, then variables and
; functions, then sections, whichever of the two is being built.

!define DONT_DD_UPDATING_MARKER "$INSTDIR\resources\native\.updating"

; Processes under $INSTDIR owned by the current user, excluding this installer.
; StartsWith on $INSTDIR keeps another user's installation out of a per-user
; run. With the marker in place a live extension helper is ignored too: its
; next start exits at once (see native/NativeHost.cs). Exits with 1 while a
; relevant process remains and 0 otherwise, so callers use the exit code.
!define PS_FIND_INSTALL_PROCESSES \
    `$$p = Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $$PID -and -not ($$_.Name -ieq 'dondownload-native-host.exe' -and (Test-Path -LiteralPath '${DONT_DD_UPDATING_MARKER}')) }; if ($$p) { exit 1 } else { exit 0 }`
!define PS_STOP_INSTALL_PROCESSES \
    `Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $$PID } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }`

; Namespaced variables so installer values never collide with the uninstaller's.
Var dont_dd_powershell_available
Var dont_dd_wait

!macro dont_dd_CreateUpdatingMarker
  ; A fresh install has no resources\native yet; CreateDirectory is a no-op then.
  CreateDirectory "$INSTDIR\resources\native"
  ClearErrors
  FileOpen $0 "${DONT_DD_UPDATING_MARKER}" w
  ${IfNot} ${Errors}
    FileWrite $0 "DonDownload is updating."
    FileClose $0
  ${EndIf}
!macroend

!macro dont_dd_Init
  StrCpy $dont_dd_powershell_available "0"
  IfFileExists "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" 0 done
    ; An ExecutionPolicy of Restricted blocks -C scripts even with -NoProfile.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }"`
    Pop $0
    ${If} $0 == 0
      StrCpy $dont_dd_powershell_available "1"
    ${EndIf}
  done:
!macroend

; Asks the app to close without forcing it so it can finish writing. Targets
; only the current user's DonDownload.exe; the installer is not that executable,
; so no PID filter is needed (and cmd has no $PID to compare against anyway).
!macro dont_dd_RequestAppClose
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" >NUL 2>NUL`
  Pop $0
!macroend

; Force-stops every process that still runs from $INSTDIR.
!macro dont_dd_StopInstallProcesses
  ${If} $dont_dd_powershell_available == 1
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "${PS_STOP_INSTALL_PROCESSES}"`
    Pop $0
  ${EndIf}
  ; Also covers PowerShell without Get-CimInstance and any path the call above
  ; missed. These are the executables the installer places under $INSTDIR, and
  ; neither this installer nor the uninstaller is one of them, so no PID filter
  ; is needed.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C for %F in ("${APP_EXECUTABLE_FILENAME}" "Uninstall ${PRODUCT_FILENAME}.exe" "dondownload-native-host.exe" "dondownload-tray.exe" "aria2c.exe" "yt-dlp.exe" "ffmpeg.exe" "ffprobe.exe") do taskkill /F /T /IM "%F" /FI "USERNAME eq %USERNAME%" >NUL 2>NUL`
  Pop $0
!macroend

; Sets $dont_dd_wait to 1 while a process from $INSTDIR, other than this
; installer, is running. A live extension helper only counts when the update
; marker is missing; PS_FIND_INSTALL_PROCESSES decides that and reports it in
; its exit code.
!macro dont_dd_CheckInstallProcesses
  Push $0
  StrCpy $dont_dd_wait "0"
  ${If} $dont_dd_powershell_available == 1
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "${PS_FIND_INSTALL_PROCESSES}"`
    Pop $0
    ${If} $0 == 1
      StrCpy $dont_dd_wait "1"
    ${EndIf}
  ${Else}
    ; Same filter and anchored match as electron-builder's own fallback.
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $0
    ${If} $0 == 0
      StrCpy $dont_dd_wait "1"
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

; Retry asks again; Cancel leaves with the marker removed.
!macro dont_dd_AskCannotBeClosed LABEL
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY dont_dd_retry_${LABEL}
  Delete "${DONT_DD_UPDATING_MARKER}"
  Quit
  dont_dd_retry_${LABEL}:
!macroend

; Runs on every install, including a fresh one where $INSTDIR does not exist
; yet, so nothing here may assume an installation is present.
!macro customCheckAppRunning
  !insertmacro dont_dd_Init
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ; Written before anything is stopped, so a helper that starts from here on
    ; exits at once instead of being stopped and restarted in a loop.
    !insertmacro dont_dd_CreateUpdatingMarker

    !insertmacro dont_dd_CheckInstallProcesses
    ${If} $dont_dd_wait == 1
      DetailPrint "$(appClosing)"
      !insertmacro dont_dd_RequestAppClose
      ; Give the app a moment to quit and release its files, then stop whatever
      ; is left, including the extension helper that was running.
      Sleep 1500
      !insertmacro dont_dd_StopInstallProcesses
      Sleep 500

      ; Ask for the app to close for up to about 10 s. With PowerShell every
      ; pass finds and stops whatever is left, which covers a user started
      ; process that needs a moment to let go of its files.
      StrCpy $R0 0
      dont_dd_settle:
        !insertmacro dont_dd_CheckInstallProcesses
        ${If} $dont_dd_wait == 1
          ${If} $dont_dd_powershell_available == 1
            !insertmacro dont_dd_StopInstallProcesses
          ${EndIf}
          IntOp $R0 $R0 + 1
          ${If} $R0 < 10
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 1000
            Goto dont_dd_settle
          ${EndIf}
          !insertmacro dont_dd_AskCannotBeClosed settle
          StrCpy $R0 0
          Goto dont_dd_settle
        ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; customInstall runs after the new application files are written and after the
; old installation was renamed away, and before the finish page, so the marker
; is gone by the time the installer can start the app.
!macro customInstall
  ; A helper the browser started before the marker took effect is stopped here.
  ; While the marker exists it cannot come back, so the checks below no longer
  ; wait for it.
  ${If} ${FileExists} "${DONT_DD_UPDATING_MARKER}"
    ${AndIf} $dont_dd_powershell_available == 1
    !insertmacro dont_dd_StopInstallProcesses
    Sleep 300

    StrCpy $R1 0
    dont_dd_final_settle:
      !insertmacro dont_dd_CheckInstallProcesses
      ${If} $dont_dd_wait == 1
        !insertmacro dont_dd_StopInstallProcesses
        IntOp $R1 $R1 + 1
        ${If} $R1 < 5
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 1000
          Goto dont_dd_final_settle
        ${EndIf}
        !insertmacro dont_dd_AskCannotBeClosed final
        StrCpy $R1 0
        Goto dont_dd_final_settle
      ${EndIf}
  ${EndIf}

  Delete "${DONT_DD_UPDATING_MARKER}"
!macroend

; The finish page is the last thing the installer does, including starting the
; app from its "run" option. Clearing the marker on leaving it means the new
; app and any helper the browser starts always see a finished installation.
; MUI reads MUI_PAGE_CUSTOMFUNCTION_LEAVE when the finish page is inserted and
; undefines it afterwards, so this is the one hook the page offers. The
; uninstaller script defines its own pages from the same file, where an
; unconditioned MUI_PAGE_CUSTOMFUNCTION_* would be used by un. pages and
; rejected: an installer function cannot be called from there.
!ifndef BUILD_UNINSTALLER
  Function dont_dd_FinishLeave
    Delete "${DONT_DD_UPDATING_MARKER}"
    !ifdef DONT_DD_PREVIOUS_FINISH_LEAVE
      Call ${DONT_DD_PREVIOUS_FINISH_LEAVE}
    !endif
  FunctionEnd

  !ifdef MUI_PAGE_CUSTOMFUNCTION_LEAVE
    !define DONT_DD_PREVIOUS_FINISH_LEAVE ${MUI_PAGE_CUSTOMFUNCTION_LEAVE}
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE dont_dd_FinishLeave
!endif

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
