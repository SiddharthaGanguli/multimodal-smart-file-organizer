param([string]$NodePath)
$ErrorActionPreference = 'Stop'

$serverPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'serve.mjs')).Path
$repositoryPath = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runtimePath = Join-Path $repositoryPath '.pr-reviews\picker-helper'
$recordPath = Join-Path $runtimePath 'process.json'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null

function Get-BridgeHealth {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 1
        if ($result.service -eq 'filewise-picker-bridge' -and $result.protocol -eq 1 -and $result.pid -gt 0) {
            return $result
        }
    } catch { }
    return $null
}

function Save-BridgeProcess([int]$ProcessId) {
    $runningProcess = Get-Process -Id $ProcessId
    [pscustomobject]@{
        pid = $ProcessId
        startedUtc = $runningProcess.StartTime.ToUniversalTime().ToString('o')
        serverPath = $serverPath
        nodePath = $runningProcess.Path
    } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
}

$health = Get-BridgeHealth
if ($health) {
    if ($health.serverPath -ne $serverPath) {
        throw 'Port 8765 belongs to a different helper checkout. Stop that instance before starting this one.'
    }
    Write-Output "Filewise Picker helper is already running (PID $($health.pid))."
    exit 0
}
if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8765 is already occupied by an unrecognized process. No process was stopped.'
}
if (!$NodePath) {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
    else {
        $NodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    }
}
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js was not found. Install Node 22 or newer, or pass -NodePath with its full path.'
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$bridgeProcess = Start-Process -FilePath $NodePath -ArgumentList ('"' + $serverPath + '"') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtimePath 'stdout.log') `
    -RedirectStandardError (Join-Path $runtimePath 'stderr.log')

$deadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $health = Get-BridgeHealth
    if ($health -and [int]$health.pid -eq $bridgeProcess.Id -and $health.serverPath -eq $serverPath) {
        Save-BridgeProcess $bridgeProcess.Id
        Write-Output "Filewise Picker helper is running in the background (PID $($bridgeProcess.Id))."
        Write-Output 'Ready: http://127.0.0.1:8765/picker.html'
        exit 0
    }
    $bridgeProcess.Refresh()
    if ($bridgeProcess.HasExited) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw "The helper did not become ready. Check $runtimePath\stderr.log."
