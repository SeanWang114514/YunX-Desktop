# YunX-Desktop Start Menu shortcut manager (ASCII only) -- on-demand, never automatic.
#
# Windows only raises a toast from an unpackaged desktop app when a Start Menu shortcut carrying
# the AppUserModelID exists; without it Show() throws nothing yet the toast is silently dropped.
# The app therefore offers this as an explicit opt-in in Settings (and can revoke it any time).
#
# Usage:
#   powershell -File toast_shortcut.ps1 -Action create -Launcher <exe> [-Icon <ico>]
#   powershell -File toast_shortcut.ps1 -Action remove
# Prints one of: created | exists | removed | absent
param(
    [Parameter(Mandatory = $true)][ValidateSet('create', 'remove')][string]$Action,
    [string]$Launcher = '',
    [string]$Icon = ''
)
$ErrorActionPreference = 'Stop'
$Aumid = 'YunX.Desktop.NativeUpload'

$programs = [Environment]::GetFolderPath('Programs')
if ([string]::IsNullOrEmpty($programs)) { throw 'Start Menu Programs folder not found' }
# shortcut name matches the Native Upload installer's Chinese name; use code points so this file
# stays pure ASCII (PowerShell 5.1 reads BOM-less UTF-8 as ANSI and would mangle a literal)
$name = "$([char]0x4E91)$([char]0x6790)$([char]0x00B7)$([char]0x539F)$([char]0x751F)$([char]0x4E0A)$([char]0x4F20)$([char]0x7248).lnk"
$lnk = Join-Path $programs $name

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class YunXToastShortcut {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out int c);
        int GetAt(int i, out PROPERTYKEY k);
        int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
        int Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr ctx, int flags, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    public static void SetAumid(string lnkPath, string aumid) {
        var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
        var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var pv = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
        try { store.SetValue(ref key, ref pv); store.Commit(); }
        finally { Marshal.FreeCoTaskMem(pv.p); Marshal.ReleaseComObject(store); }
    }
}
'@

if ($Action -eq 'remove') {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Output 'removed' }
    else { Write-Output 'absent' }
    exit 0
}

if ([string]::IsNullOrEmpty($Launcher) -or -not (Test-Path $Launcher)) {
    throw "launcher not found: $Launcher"
}
$created = $false
if (-not (Test-Path $lnk)) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $Launcher
    $s.WorkingDirectory = (Split-Path $Launcher -Parent)
    if (-not [string]::IsNullOrEmpty($Icon)) { $s.IconLocation = $Icon }
    $s.Description = 'YunX-Desktop'
    $s.Save()
    $created = $true
}
# also patch an already existing shortcut (e.g. the installer's Start Menu entry has no AUMID)
[YunXToastShortcut]::SetAumid($lnk, $Aumid)
if ($created) { Write-Output 'created' } else { Write-Output 'exists' }
