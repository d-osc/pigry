# Independent cross-check of the SEED_TEST_KEYS digests (different parser
# and different crypto stack than .pigry/tools/seed-digests.mjs).
# Run: pwsh -NoProfile -File .pigry/tools/verify-seed-digests.ps1   (pre-fix)
$lines = Get-Content -LiteralPath 'src/lib/aiProviders.ts'
$start = ($lines | Select-String -SimpleMatch 'SEED_TEST_KEYS = [' | Select-Object -First 1).LineNumber
$found = @()
for ($i = $start; $i -lt $lines.Count -and $found.Count -lt 2; $i++) {
  if ($lines[$i] -match "^\s*'([^']*)',?\s*$") { $found += $Matches[1] }
}
if ($found.Count -ne 2) { throw "expected 2 literals, found $($found.Count)" }
foreach ($key in $found) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
  $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  Write-Output "$($key.Length) chars  $hex"
}
