# YunX-Desktop toast progress renderer (ASCII only; display text arrives via stdin UTF-8)
#
# stdin protocol (UTF-8, one command per line, pipe-separated):
#   prog|<line1>|<pct 0-99>|<line2>|<value string>|<status label>   show/update progress toast
#   done|<title>|<summary line>                                     show completion toast, then exit
#   exit                                                            remove progress toast, then exit
#
# Update behaviour: the first progress toast pops normally; every later one re-sends with
# SuppressPopup = true, which replaces the entry in the notification center WITHOUT popping a
# banner or playing a sound (plain re-Show() would do both every single time).
#
# Templates use @@TOKEN@@ placeholders instead of the composite-format operator ("-f"):
# inside a method argument list PowerShell treats commas as extra method arguments, so an
# inline `$tpl -f $a, $b, $c` silently passes only the first value.
#
# NOTE: keep this file pure ASCII. It is extracted from the JAR without a BOM, and
# PowerShell 5.1 reads BOM-less files using the ANSI code page, which mangles non-ASCII text.
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Aumid = 'YunX.Desktop.NativeUpload'
$Tag = 'yunx-dl'
$Group = 'yunx'
$SettingKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\' + $Aumid

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
Write-Output ("notifier.Setting=" + $notifier.Setting)

$progXml = '<toast><visual><binding template="ToastGeneric"><text>@@LINE1@@</text><text>@@LINE2@@</text><progress title="@@PROGTITLE@@" value="@@VALUE@@" valueStringOverride="@@VALUESTR@@" status="@@STATUS@@"/></binding></visual></toast>'
$doneXml = '<toast><visual><binding template="ToastGeneric"><text>@@LINE1@@</text><text>@@LINE2@@</text></binding></visual></toast>'

function New-ToastXml([string]$tpl, [string]$line1, [string]$line2, [string]$progTitle, [string]$value, [string]$valueString, [string]$status) {
    return $tpl.Replace('@@LINE1@@', $line1).Replace('@@LINE2@@', $line2).Replace('@@PROGTITLE@@', $progTitle).Replace('@@VALUE@@', $value).Replace('@@VALUESTR@@', $valueString).Replace('@@STATUS@@', $status)
}

# Windows keeps "LastNotificationAddedTime" for every app: it advances each time a
# notification is really accepted. Unchanged before/after a send means Windows dropped it.
function Write-Oracle {
    $v = (Get-ItemProperty -Path $SettingKey -Name LastNotificationAddedTime -ErrorAction SilentlyContinue).LastNotificationAddedTime
    Write-Output ("oracle.LastNotificationAddedTime=" + $v)
}

$sessionShown = $false
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Split('|')
    if ($p[0] -eq 'exit') { break }

    if ($p[0] -eq 'done') {
        try {
            $x = New-Object Windows.Data.Xml.Dom.XmlDocument
            $x.LoadXml((New-ToastXml $doneXml $p[1] $p[2] '' '' '' ''))
            $t = New-Object Windows.UI.Notifications.ToastNotification($x)
            $t.Tag = 'yunx-done'; $t.Group = $Group
            $notifier.Show($t)
            Write-Output 'Marker=DoneShown'
        } catch {
            Write-Output ('Done FAILED: ' + $_.Exception.Message)
        }
        break
    }

    if ($p[0] -eq 'prog') {
        $pct = [int]$p[2]
        if ($pct -lt 0) { $pct = 0 }
        if ($pct -gt 100) { $pct = 100 }
        # progress value must be a 0.0-1.0 double; format with the invariant culture so
        # locales using ',' as the decimal separator do not break the XML
        $value = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.00}', $pct / 100.0)
        try {
            $x = New-Object Windows.Data.Xml.Dom.XmlDocument
            $x.LoadXml((New-ToastXml $progXml $p[1] $p[3] $p[1] $value $p[4] $p[5]))
            $t = New-Object Windows.UI.Notifications.ToastNotification($x)
            $t.Tag = $Tag; $t.Group = $Group
            if ($sessionShown) {
                # update in place: no banner, no sound
                $t.SuppressPopup = $true
                $notifier.Show($t)
                Write-Output ('Marker=Updated pct=' + $pct)
            } else {
                $notifier.Show($t)
                $sessionShown = $true
                Write-Output 'Marker=FirstShown'
            }
        } catch {
            Write-Output ('Show FAILED: ' + $_.Exception.Message)
        }
        Write-Oracle
    }
}
try {
    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $Aumid) | Out-Null
} catch {}
