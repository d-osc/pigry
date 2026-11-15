param([string]$MakeNsis = "$env:LOCALAPPDATA/tauri/NSIS/makensis.exe")
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('pigry-context-menu-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$registryRoot = 'Software\PigryContextMenuTests\' + (Split-Path $fixture -Leaf)
$registryPath = 'HKCU:\' + $registryRoot
$hooks = Get-Content -Raw (Join-Path $PSScriptRoot '../src-tauri/windows/context-menu.nsh')
$hooks.Replace('Software\Classes', $registryRoot) | Set-Content (Join-Path $fixture 'hooks.nsh')
$installDir = Join-Path $fixture 'Application with spaces'
function Run-Hook([string]$Macro) {
    $script = @'
Unicode true
!define MAINBINARYNAME "pigry"
!include "hooks.nsh"
Name "Pigry context menu test"
OutFile "hook.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  SetShellVarContext current
  SetRegView 64
  StrCpy $INSTDIR "INSTALL_DIRECTORY"
  !insertmacro HOOK_MACRO
SectionEnd
'@
    $script.Replace('INSTALL_DIRECTORY', $installDir).Replace('HOOK_MACRO', $Macro) | Set-Content (Join-Path $fixture 'hook.nsi')
    & $MakeNsis /V2 (Join-Path $fixture 'hook.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS hook compilation failed' }
    $process = Start-Process -FilePath (Join-Path $fixture 'hook.exe') -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw 'NSIS hook execution failed' }
}
try {
    Run-Hook 'NSIS_HOOK_POSTINSTALL'
    foreach ($target in @(@('Directory\shell\Pigry', '%1'), @('Directory\Background\shell\Pigry', '%V'))) {
        $key = Join-Path $registryPath $target[0]
        if ((Get-Item $key).GetValue('') -ne 'Open with Pigry') { throw 'Menu label missing' }
        if ((Get-Item $key).GetValue('Icon') -ne ('"' + $installDir + '\pigry.exe",0')) { throw 'Icon quoting mismatch' }
        $expected = '"' + $installDir + '\pigry.exe" --open-folder "' + $target[1] + '\."'
        if ((Get-Item (Join-Path $key 'command')).GetValue('') -ne $expected) { throw 'Folder command quoting mismatch' }
    }
    Run-Hook 'NSIS_HOOK_POSTUNINSTALL'
    if ((Test-Path "$registryPath\Directory\shell\Pigry") -or (Test-Path "$registryPath\Directory\Background\shell\Pigry")) { throw 'Uninstall left menu entries' }
    'PASS: NSIS folder/background registration, quoted commands, icons and uninstall cleanup'
} finally {
    if (Test-Path $registryPath) { Remove-Item -LiteralPath $registryPath -Recurse -Force }
}
