# Send keystrokes to a native OS dialog (e.g. VS Code modal confirmations,
# Win32 class #32770) owned by the dev-host process, then optionally take a
# system-level screenshot. Native dialogs are invisible to CDP screenshots.
#   powershell -File src/win/dialog.ps1 -Keys '{ENTER}' [-OutFile shots\screen.png]
#   powershell -File src/win/dialog.ps1 -Keys '{ESC}' -Title 'Delete this'
# Common keys: '{ENTER}' = default button (usually Confirm), '{ESC}' = Cancel.
#
# The helper does not guess which dialog to talk to. It lists the dev host's
# visible #32770 windows, narrows them with `-Title` (a regex on the window
# title) when given, and refuses to send anything unless exactly one candidate is
# left, its owner window belongs to the dev-host process, and it actually became
# the foreground window. Typing into "the first visible #32770" and reporting
# success — what this script used to do — sent the keys to another window when
# two dialogs were open or activation was refused.
param([string]$Keys = '', [string]$OutFile = '', [string]$Title = '')
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Win32Enum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public class DialogInfo {
    public IntPtr Handle;
    public string Title;
    public uint OwnerPid;
  }

  public static List<DialogInfo> FindDialogs(uint targetPid) {
    var result = new List<DialogInfo>();
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) {
        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, 256);
        if (cls.ToString() == "#32770") {
          var title = new StringBuilder(256);
          GetWindowText(hWnd, title, 256);
          IntPtr owner = GetWindow(hWnd, 4); // GW_OWNER
          uint ownerPid = 0;
          if (owner != IntPtr.Zero) { uint op; GetWindowThreadProcessId(owner, out op); ownerPid = op; }
          var info = new DialogInfo();
          info.Handle = hWnd;
          info.Title = title.ToString();
          info.OwnerPid = ownerPid;
          result.Add(info);
        }
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
. (Join-Path $PSScriptRoot 'devhost.ps1')
$proc = Find-DevHostProcess
if (-not $proc) { Write-Output 'dev host not found'; exit 1 }

$dialogs = [Win32Enum]::FindDialogs($proc.Id)
Write-Output ("visible #32770 dialogs of the dev host: " + $dialogs.Count)
foreach ($dialog in $dialogs) {
  $ownerPid = if ($dialog.OwnerPid -eq 0) { 'none' } else { [string]$dialog.OwnerPid }
  Write-Output ("  title=[" + $dialog.Title + "] ownerPid=" + $ownerPid)
}

$candidates = @($dialogs)
if ($Title) {
  $candidates = @($dialogs | Where-Object { $_.Title -match $Title })
  if ($candidates.Count -eq 0) {
    Write-Output ("no visible dialog matches -Title /" + $Title + "/; refusing to guess")
    exit 1
  }
}
if ($Keys) {
  if ($candidates.Count -eq 0) {
    Write-Output 'no native dialog to send keys to'
    exit 1
  }
  if ($candidates.Count -gt 1) {
    Write-Output ("ambiguous target: " + $candidates.Count + " dialogs match; narrow it with -Title")
    exit 1
  }
  $d = $candidates[0]
  # The dialog itself is already known to belong to the dev-host process
  # (FindDialogs filters by pid); a dialog that has an owner window must have it
  # in that process too, so an unrelated #32770 of the same process cannot be
  # mistaken for the dev host's modal.
  if ($d.OwnerPid -ne 0 -and $d.OwnerPid -ne $proc.Id) {
    Write-Output (
      "refusing to send keys: dialog '" + $d.Title + "' is owned by pid " + $d.OwnerPid +
      ", not the dev host (" + $proc.Id + ")"
    )
    exit 1
  }
  $h = $d.Handle
  $fg = [Win32Enum]::GetForegroundWindow()
  $fgThread = [Win32Enum]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
  $cur = [Win32Enum]::GetCurrentThreadId()
  [Win32Enum]::AttachThreadInput($cur, $fgThread, $true) | Out-Null
  [Win32Enum]::BringWindowToTop($h) | Out-Null
  [Win32Enum]::SetForegroundWindow($h) | Out-Null
  [Win32Enum]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 500
  if ([Win32Enum]::GetForegroundWindow() -ne $h) {
    Write-Output ("refusing to send " + $Keys + ": dialog '" + $d.Title + "' did not become the foreground window")
    exit 1
  }
  $w = New-Object -ComObject WScript.Shell
  $w.SendKeys($Keys)
  Write-Output ("sent " + $Keys + " to dialog '" + $d.Title + "'")
  Start-Sleep -Milliseconds 800
  if ([Win32Enum]::IsWindowVisible($h)) {
    Write-Output ("dialog '" + $d.Title + "' is still open after " + $Keys)
  } else {
    Write-Output ("dialog '" + $d.Title + "' closed after " + $Keys)
  }
}
if ($OutFile) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ("saved " + $OutFile)
}
