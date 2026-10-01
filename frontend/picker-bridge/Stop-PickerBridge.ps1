$ErrorActionPreference = 'Stop'
$serverPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'serve.mjs')).Path
$repositoryPath = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$recordPath = Join-Path $repositoryPath '.pr-reviews\picker-helper\process.json'
if (!(Test-Path -LiteralPath $recordPath -PathType Leaf)) {
    Write-Output 'No background Filewise Picker helper is recorded.'
    exit 0
}
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$runningProcess = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
if (!$runningProcess) {
    Remove-Item -LiteralPath $recordPath
    Write-Output 'Filewise Picker helper is already stopped.'
    exit 0
}
$expectedStart = [DateTime]::Parse($record.startedUtc).ToUniversalTime()
if ($record.serverPath -ne $serverPath -or
    $runningProcess.StartTime.ToUniversalTime().Ticks -ne $expectedStart.Ticks -or
    !$record.nodePath -or $runningProcess.Path -ne $record.nodePath) {
    throw 'The recorded PID no longer identifies this helper. No process was stopped.'
}
Stop-Process -Id $runningProcess.Id
Remove-Item -LiteralPath $recordPath
Write-Output 'Filewise Picker helper stopped.'
