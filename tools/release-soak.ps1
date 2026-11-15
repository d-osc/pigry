param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$Repository,
    [int]$Seconds = 300,
    [string]$Output = 'docs/release-large-soak.json'
)
$ErrorActionPreference = 'Stop'
function Normalize-RepoPath([string]$Path) {
    if (!$Path) { return '' }
    return [IO.Path]::GetFullPath($Path.Replace('/', '\')).TrimEnd('\').ToUpperInvariant()
}
$normalizedRepository = Normalize-RepoPath $Repository
if (Get-Process pigry,pigry-validation -ErrorAction SilentlyContinue) { throw 'Close other Pigry instances before the release repository check' }
$root = Join-Path $env:TEMP ('pigry-release-soak-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$config = Join-Path $env:APPDATA 'com.pigry.app/config.json'
$existed = Test-Path -LiteralPath $config
$original = if ($existed) { [IO.File]::ReadAllBytes($config) } else { $null }
$originalData = if ($existed) { Get-Content -LiteralPath $config | ConvertFrom-Json } else { @{recent=@();active=$null} }
if ($existed) { [IO.File]::WriteAllBytes((Join-Path $root 'original-config.json'), $original) }
New-Item -ItemType Directory -Path (Split-Path $config) -Force | Out-Null
@{recent=@($Repository);active=$null} | ConvertTo-Json | Set-Content -LiteralPath $config
$restoredExactly = $false
try {
    & node (Join-Path $PSScriptRoot 'native-soak.mjs') $Executable $Repository $Seconds $Output (Join-Path $root 'profile')
    if ($LASTEXITCODE -ne 0) { throw 'Release repository stress run failed' }
} finally {
    $current = Get-Content -LiteralPath $config | ConvertFrom-Json
    $otherPaths = @($current.recent | Where-Object { (Normalize-RepoPath $_) -ne $normalizedRepository })
    if ($otherPaths.Count -eq 0 -and (!$current.active -or (Normalize-RepoPath $current.active) -eq $normalizedRepository)) {
        if ($existed) { [IO.File]::WriteAllBytes($config, $original) }
        else { Remove-Item -LiteralPath $config }
        $restoredExactly = $true
    } else {
        # Preserve a concurrent user's additions instead of replacing their configuration.
        $recent = @($otherPaths)
        foreach ($path in $originalData.recent) { if ($path -notin $recent) { $recent += $path } }
        $current.recent = @($recent | Select-Object -First 10)
        if ((Normalize-RepoPath $current.active) -eq $normalizedRepository) { $current.active=$originalData.active }
        $current | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config
    }
}
$result = Get-Content -LiteralPath $Output | ConvertFrom-Json -AsHashtable
$result.scope = 'Optimized release, real 10000-commit/20000-file repository, isolated WebView profile; temporary recent-repository config restored afterward'
$result.configRestoredExactly = $restoredExactly
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output
Write-Output ('Release config restored exactly: ' + $restoredExactly)
