param([Parameter(Mandatory)][string]$Repository, [int]$Cycles = 20)
$ErrorActionPreference = 'Stop'
$probe = (Resolve-Path (Join-Path $PSScriptRoot '../src-tauri/target/debug/examples/validation_probe.exe')).Path
$lines = & $probe large $Repository $Cycles
if ($LASTEXITCODE -ne 0) { throw 'Large repository backend probe failed' }
$rows = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
$timings = @{}
foreach ($field in @('stateMs','historyMs','treeMs')) {
    $sorted = @($rows | ForEach-Object { $_.$field } | Sort-Object)
    $timings[$field] = @{median=$sorted[[math]::Floor($sorted.Count/2)];p95=$sorted[[math]::Min($sorted.Count-1,[math]::Ceiling($sorted.Count*0.95)-1)];max=$sorted[-1]}
}
@{checkedAt=[DateTime]::UtcNow.ToString('o');scope='Debug backend, same functions as desktop; warm repeated reads; not a release benchmark';cycles=$rows.Count;fixture=@{commits=$rows[0].commits;files=$rows[0].files;changes=$rows[0].changes;historyRows=$rows[0].historyRows};timings=$timings;samples=$rows} | ConvertTo-Json -Depth 6
