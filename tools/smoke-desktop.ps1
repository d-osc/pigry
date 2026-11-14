param([int]$Samples = 3)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('pigry-desktop-smoke-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $root 'workspace'
$remote = Join-Path $root 'remote.git'
$configDir = Join-Path $root 'config'
New-Item -ItemType Directory -Path $repo,$remote,$configDir | Out-Null
function Invoke-SmokeGit([string]$Directory, [string[]]$GitArgs) {
    & git.exe -C $Directory @GitArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git failed: $GitArgs" }
}
Invoke-SmokeGit $remote @('init','--bare')
Invoke-SmokeGit $repo @('init','-b','main')
Invoke-SmokeGit $repo @('config','user.name','Pigry Validation')
Invoke-SmokeGit $repo @('config','user.email','validation@example.invalid')
Invoke-SmokeGit $repo @('remote','add','origin',$remote)
Set-Content (Join-Path $repo 'README.md') "# Validation`n`nDisposable desktop smoke repository."
Invoke-SmokeGit $repo @('add','README.md')
Invoke-SmokeGit $repo @('commit','-m','Initial validation commit')
@{recent=@($repo);active=$repo} | ConvertTo-Json | Set-Content (Join-Path $configDir 'config.json')
$exe = (Resolve-Path (Join-Path $PSScriptRoot '../src-tauri/target/debug/pigry.exe')).Path
$oldConfig = $env:PIGRY_TEST_CONFIG_DIR
$oldWebview = $env:WEBVIEW2_USER_DATA_FOLDER
$measurements = @()
try {
    $env:PIGRY_TEST_CONFIG_DIR = $configDir
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'webview'
    for ($sample=0; $sample -lt $Samples; $sample++) {
        $readyFile = Join-Path $configDir 'startup.json'
        if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
        $child = Start-Process -FilePath $exe -WorkingDirectory $repo -WindowStyle Hidden -PassThru
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(25)
            while (!(Test-Path -LiteralPath $readyFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
            if (!(Test-Path -LiteralPath $readyFile)) { throw 'Desktop Home did not report ready within 25 seconds. Start npm run dev first.' }
            $ready = Get-Content $readyFile | ConvertFrom-Json
            $processes = Get-CimInstance Win32_Process
            $ids = @([int]$child.Id)
            do {
                $next = @($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object {[int]$_.ProcessId})
                $ids += $next
            } while ($next.Count -gt 0)
            $metrics = Get-Process -Id $ids -ErrorAction SilentlyContinue
            $measurements += [pscustomobject]@{sample=$sample+1;homeReadyMs=$ready.homeReadyMs;processes=$metrics.Count;workingSetMiB=[math]::Round(($metrics | Measure-Object WorkingSet64 -Sum).Sum/1MB,1);privateMiB=[math]::Round(($metrics | Measure-Object PrivateMemorySize64 -Sum).Sum/1MB,1)}
        } finally { & taskkill.exe /PID $child.Id /T /F 2>&1 | Out-Null }
    }
} finally { $env:PIGRY_TEST_CONFIG_DIR=$oldConfig; $env:WEBVIEW2_USER_DATA_FOLDER=$oldWebview }
$result = [pscustomobject]@{scope='Debug Tauri + Vite, Home rendered, includes child WebView2 processes; first sample fresh WebView profile, remaining samples cached';samples=$measurements;fixtureRoot=$root;repository=$repo;config=$configDir}
$result | ConvertTo-Json -Depth 5
