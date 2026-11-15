param([string]$PrivateRepository, [string]$PublicRepository = 'd-osc/pigry')
$ErrorActionPreference = 'Stop'
$probe = (Resolve-Path (Join-Path $PSScriptRoot '../src-tauri/target/debug/examples/validation_probe.exe')).Path
$root = Join-Path $env:TEMP ('pigry-github-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
if (!$PrivateRepository) {
    $login = & gh api user --jq .login
    if ($LASTEXITCODE -ne 0) { throw 'GitHub account lookup failed' }
    $PrivateRepository = & gh repo list $login --visibility private --limit 1 --json nameWithOwner --jq '.[0].nameWithOwner'
}
$results = @()
foreach ($entry in @(@{label='public';name=$PublicRepository}, @{label='private';name=$PrivateRepository})) {
    if (!$entry.name) { throw 'A readable private repository is required for the private live check' }
    $dir = Join-Path $root $entry.label
    New-Item -ItemType Directory -Path $dir | Out-Null
    & git -C $dir init -q
    & git -C $dir remote add origin ('https://github.com/' + $entry.name + '.git')
    $result = & $probe github $dir
    if ($LASTEXITCODE -ne 0) { throw ('GitHub backend validation failed: ' + $entry.label) }
    $results += @{scope=$entry.label; backend=($result | ConvertFrom-Json)}
}
$oldToken = $env:GH_TOKEN
try {
    $env:GH_TOKEN = 'deliberately-invalid-validation-token'
    $failure = & $probe github (Join-Path $root 'public') 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $failure -notmatch '401|Bad credentials') { throw 'Invalid-token check did not return the expected authentication failure' }
    $results += @{scope='invalid-token';expectedFailure='401';passed=$true}
} finally { $env:GH_TOKEN=$oldToken }
$recovery = & $probe github (Join-Path $root 'public')
if ($LASTEXITCODE -ne 0) { throw 'GitHub did not recover after removing process-local invalid token' }
$results += @{scope='restored-credentials';passed=$true}
@{checkedAt=[DateTime]::UtcNow.ToString('o');mode='Read-only real backend calls; private repository names and contents omitted';results=$results} | ConvertTo-Json -Depth 6
