# Registers a Task Scheduler job that starts the bridge (start-window.cmd, minimized) at your logon.
# Run once:   powershell -ExecutionPolicy Bypass -File .\install-startup.ps1
# Remove:     Unregister-ScheduledTask -TaskName "wow-ai bridge" -Confirm:$false
$cmd = Join-Path $PSScriptRoot 'start-window.cmd'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start /min `"`" `"$cmd`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'wow-ai bridge' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host 'Registered "wow-ai bridge": starts bridge\start-window.cmd minimized at logon.'
Write-Host 'Remove later with:  Unregister-ScheduledTask -TaskName "wow-ai bridge" -Confirm:$false'
