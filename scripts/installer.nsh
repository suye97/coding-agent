; A Low token cannot write to a normal per-user install directory. NSIS would
; otherwise report that the app could not be closed when copying files fails.
!macro customInit
  Call CheckInstallerIntegrity
!macroend

!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
Function CheckInstallerIntegrity
  ; TokenIntegrityLevel (25) returns TOKEN_MANDATORY_LABEL, whose first
  ; field is the SID pointer. The first subauthority of S-1-16 is its RID.
  StrCpy $0 0
  StrCpy $1 0
  StrCpy $4 -1
  System::Call 'kernel32::GetCurrentProcess() p.r2'
  System::Call 'advapi32::OpenProcessToken(p r2, i 0x0008, *p .r0) i.r3'
  StrCmp $3 0 integrityDone
  System::Call 'advapi32::GetTokenInformation(p r0, i 25, p 0, i 0, *i .r2)'
  StrCmp $2 0 integrityDone
  System::Alloc $2
  Pop $1
  StrCmp $1 0 integrityDone
  System::Call 'advapi32::GetTokenInformation(p r0, i 25, p r1, i r2, *i .r2) i.r3'
  StrCmp $3 0 integrityDone
  System::Call '*$1(p .r3)'
  System::Call 'advapi32::GetSidSubAuthority(p r3, i 0) p.r3'
  StrCmp $3 0 integrityDone
  System::Call '*$3(i .r4)'
  integrityDone:
  ${If} $1 != 0
    System::Free $1
  ${EndIf}
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}

  ${If} $4 == -1
    MessageBox MB_OK|MB_ICONSTOP "无法检查 Windows 安装权限，安装已停止。" /SD IDOK
    SetErrorLevel 4
    Quit
  ${ElseIf} $4 < 0x2000
    MessageBox MB_OK|MB_ICONSTOP "安装器正在低完整性环境中运行，Windows 不允许它写入安装目录。这不是应用未关闭。请从可信的正常本地目录打开安装包，不要从隔离的工作区直接运行。" /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
FunctionEnd
!endif
