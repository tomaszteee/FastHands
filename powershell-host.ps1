$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$runspace.Open()

$toolchainBootstrap = Join-Path $PSScriptRoot 'toolchain-env.ps1'
if (Test-Path -LiteralPath $toolchainBootstrap) {
    $bootstrapPowerShell = [System.Management.Automation.PowerShell]::Create()
    try {
        $bootstrapPowerShell.Runspace = $runspace
        $escapedBootstrap = $toolchainBootstrap.Replace("'", "''")
        $null = $bootstrapPowerShell.AddScript("& '$escapedBootstrap'", $false)
        $null = $bootstrapPowerShell.Invoke()
        if ($bootstrapPowerShell.HadErrors) {
            $messages = @($bootstrapPowerShell.Streams.Error | ForEach-Object { [string]$_ }) -join '; '
            throw "Fast Hands toolchain bootstrap failed: $messages"
        }
    } finally {
        $bootstrapPowerShell.Dispose()
    }
}

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }

        $request = $null
        $requestId = 'invalid-request'
        $exitCode = 1
        $savedLocation = $null
        $powerShell = $null

        try {
            $request = $line | ConvertFrom-Json
            $requestId = [string]$request.id
            if ([string]::IsNullOrWhiteSpace($requestId)) { throw 'Request id is required.' }

            if (-not [string]::IsNullOrWhiteSpace([string]$request.cwd)) {
                $savedLocation = $runspace.SessionStateProxy.Path.CurrentLocation.Path
                $runspace.SessionStateProxy.Path.SetLocation([string]$request.cwd) | Out-Null
            }

            $runspace.SessionStateProxy.SetVariable('LASTEXITCODE', 0)
            $captureSuffix = $requestId -replace '[^a-zA-Z0-9]', ''
            $successVariable = "__afh_success_$captureSuffix"
            $exitVariable = "__afh_last_exit_$captureSuffix"
            $scriptText = [string]$request.command + "`n`$global:$successVariable=`$?`n`$global:$exitVariable=`$LASTEXITCODE"
            $powerShell = [System.Management.Automation.PowerShell]::Create()
            $powerShell.Runspace = $runspace
            $null = $powerShell.AddScript($scriptText, $false)
            $null = $powerShell.AddCommand('Out-String').AddParameter('Stream').AddParameter('Width', 4096)
            $output = $powerShell.Invoke()

            foreach ($item in $output) {
                [Console]::Out.WriteLine([string]$item)
            }
            foreach ($item in $powerShell.Streams.Information) {
                [Console]::Out.WriteLine([string]$item.MessageData)
            }
            foreach ($item in $powerShell.Streams.Warning) {
                [Console]::Error.WriteLine([string]$item.Message)
            }
            foreach ($item in $powerShell.Streams.Error) {
                [Console]::Error.WriteLine([string]$item)
            }

            $capturedSuccess = $runspace.SessionStateProxy.GetVariable($successVariable)
            $lastExitCode = $runspace.SessionStateProxy.GetVariable($exitVariable)
            if ($null -ne $lastExitCode -and [int]$lastExitCode -ne 0) {
                $exitCode = [int]$lastExitCode
            } elseif ($powerShell.HadErrors -or $capturedSuccess -eq $false) {
                $exitCode = 1
            } else {
                $exitCode = 0
            }
            $runspace.SessionStateProxy.SetVariable($successVariable, $null)
            $runspace.SessionStateProxy.SetVariable($exitVariable, $null)
        } catch {
            [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())
            $exitCode = 1
        } finally {
            if ($null -ne $savedLocation) {
                try { $runspace.SessionStateProxy.Path.SetLocation($savedLocation) | Out-Null } catch {}
            }
            if ($null -ne $powerShell) { $powerShell.Dispose() }
        }

        [Console]::Out.WriteLine("__FAST_HANDS_OUT_${requestId}__:${exitCode}:END")
        [Console]::Error.WriteLine("__FAST_HANDS_ERR_${requestId}__:END")
    }
} finally {
    $runspace.Close()
    $runspace.Dispose()
}
