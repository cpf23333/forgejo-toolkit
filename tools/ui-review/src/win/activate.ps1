# Bring the isolated dev-host window to the foreground, optionally send
# keystrokes and/or take a system-level screenshot.
#   powershell -File src/win/activate.ps1 [-Keys '{ENTER}'] [-OutFile shots\screen.png]
param([string]$Keys = '', [string]$OutFile = '')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
$proc = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Extension Development Host' } | Select-Object -First 1
if (-not $proc) { Write-Output 'dev host window not found'; exit 1 }
$h = $proc.MainWindowHandle
$fg = [Win32]::GetForegroundWindow()
$fgThread = [Win32]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$cur = [Win32]::GetCurrentThreadId()
[Win32]::AttachThreadInput($cur, $fgThread, $true) | Out-Null
[Win32]::ShowWindow($h, 9) | Out-Null  # SW_RESTORE
[Win32]::BringWindowToTop($h) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
[Win32]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
Start-Sleep -Milliseconds 600
if ($Keys) {
  $w = New-Object -ComObject WScript.Shell
  $w.SendKeys($Keys)
  Write-Output ("sent " + $Keys)
  Start-Sleep -Milliseconds 600
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
