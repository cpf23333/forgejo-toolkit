# Send keystrokes to a native OS dialog (e.g. VS Code modal confirmations,
# Win32 class #32770) owned by the dev-host process, then optionally take a
# system-level screenshot. Native dialogs are invisible to CDP screenshots.
#   powershell -File src/win/dialog.ps1 -Keys '{ENTER}' [-OutFile shots\screen.png]
# Common keys: '{ENTER}' = default button (usually Confirm), '{ESC}' = Cancel.
param([string]$Keys = '', [string]$OutFile = '')
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public static List<IntPtr> FindDialogs(uint targetPid) {
    var result = new List<IntPtr>();
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) {
        var sb = new StringBuilder(256);
        GetClassName(hWnd, sb, 256);
        if (sb.ToString() == "#32770") result.Add(hWnd);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
$proc = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Extension Development Host' } | Select-Object -First 1
if (-not $proc) { Write-Output 'dev host not found'; exit 1 }
$dialogs = [Win32Enum]::FindDialogs($proc.Id)
Write-Output ("dialogs found: " + $dialogs.Count)
if ($dialogs.Count -gt 0 -and $Keys) {
  $h = $dialogs[0]
  $fg = [Win32Enum]::GetForegroundWindow()
  $fgThread = [Win32Enum]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
  $cur = [Win32Enum]::GetCurrentThreadId()
  [Win32Enum]::AttachThreadInput($cur, $fgThread, $true) | Out-Null
  [Win32Enum]::BringWindowToTop($h) | Out-Null
  [Win32Enum]::SetForegroundWindow($h) | Out-Null
  [Win32Enum]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 500
  $w = New-Object -ComObject WScript.Shell
  $w.SendKeys($Keys)
  Write-Output ("sent " + $Keys + " to dialog")
  Start-Sleep -Milliseconds 800
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
