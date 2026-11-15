param(
    [Parameter(Mandatory)][ValidateSet('install','upgrade','uninstall')][string]$Phase,
    [Parameter(Mandatory)][string]$FixtureRoot,
    [string]$Installer
)
$ErrorActionPreference = 'Stop'
$fixture = (Resolve-Path -LiteralPath $FixtureRoot).Path
if (!(Split-Path $fixture -Leaf).StartsWith('pigry-installer-')) { throw 'Expected a dedicated pigry-installer fixture directory' }
$installDir = Join-Path $fixture 'app'
$profileDir = Join-Path $fixture 'profile'
$key = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Pigry Validation'
$recordFile = Join-Path $fixture 'results.json'
$record = if (Test-Path -LiteralPath $recordFile) { Get-Content $recordFile | ConvertFrom-Json -AsHashtable } else { @{scope='Isolated NSIS packaging fixture; real optimized release payload; no publishing/signing';phases=@()} }
function Run-Installer([string]$File, [string[]]$InstallerArgs) {
    $process = Start-Process -FilePath $File -ArgumentList $InstallerArgs -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(60000)) { throw 'Installer did not exit within 60 seconds' }
    if ($process.ExitCode -ne 0) { throw ('Installer exit code: ' + $process.ExitCode) }
}
if ($Phase -eq 'install') {
    if (Test-Path $key) { throw 'Validation product is already registered; refusing to overwrite it' }
    Run-Installer (Resolve-Path -LiteralPath $Installer).Path @('/S','/NS',"/D=$installDir")
    $entry = Get-ItemProperty $key
    if ($entry.DisplayVersion -ne '0.0.9') { throw 'Unexpected initial package version' }
    $oldMarker = $env:PIGRY_INSTALLER_MARKER
    try {
        $env:PIGRY_INSTALLER_MARKER='write'
        & node (Join-Path $PSScriptRoot 'native-soak.mjs') (Join-Path $installDir 'pigry-validation.exe') '-' 2 (Join-Path $fixture 'installed-home.json') $profileDir
        if ($LASTEXITCODE -ne 0) { throw 'Installed release did not open Home' }
    } finally { $env:PIGRY_INSTALLER_MARKER=$oldMarker }
    $record.phases += @{phase='install';version=$entry.DisplayVersion;homePassed=$true;binarySha256=(Get-FileHash (Join-Path $installDir 'pigry-validation.exe')).Hash}
} elseif ($Phase -eq 'upgrade') {
    if (!(Test-Path $key)) { throw 'Initial validation installation is missing' }
    Run-Installer (Resolve-Path -LiteralPath $Installer).Path @('/S','/NS','/UPDATE',"/D=$installDir")
    $entry = Get-ItemProperty $key
    if ($entry.DisplayVersion -ne '0.1.0') { throw 'Package version did not advance' }
    $oldMarker = $env:PIGRY_INSTALLER_MARKER
    try {
        $env:PIGRY_INSTALLER_MARKER='check'
        & node (Join-Path $PSScriptRoot 'native-soak.mjs') (Join-Path $installDir 'pigry-validation.exe') '-' 2 (Join-Path $fixture 'upgraded-home.json') $profileDir
        if ($LASTEXITCODE -ne 0) { throw 'Upgraded release failed to preserve its test profile' }
    } finally { $env:PIGRY_INSTALLER_MARKER=$oldMarker }
    $hash = (Get-FileHash (Join-Path $installDir 'pigry-validation.exe')).Hash
    if ($hash -eq $record.phases[0].binarySha256) { throw 'Upgrade did not replace the app payload' }
    $record.phases += @{phase='upgrade';version=$entry.DisplayVersion;homePassed=$true;profilePreserved=$true;binaryReplaced=$true;binarySha256=$hash}
} else {
    if (!(Test-Path $key)) { throw 'Validation product is not installed' }
    Run-Installer (Join-Path $installDir 'uninstall.exe') @('/S')
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ((Test-Path $key) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if ((Test-Path $key) -or (Test-Path (Join-Path $installDir 'pigry-validation.exe'))) { throw 'Validation uninstall left the product registered or executable installed' }
    $record.phases += @{phase='uninstall';passed=$true;profileRetained=(Test-Path $profileDir)}
}
$record.checkedAt = [DateTime]::UtcNow.ToString('o')
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordFile
$record | ConvertTo-Json -Depth 6
