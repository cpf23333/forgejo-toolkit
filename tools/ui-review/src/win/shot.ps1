# Screenshot the dev host, or one of its dialogs, through the Windows API.
#
# The CDP driver can only see the webview, and `dialog.ps1`'s CopyFromScreen grab
# is affected by whatever happens to be on top. `PrintWindow` asks the window to
# render itself into a bitmap, which is what makes the state of a stubborn native
# dialog (its file-name box included) inspectable.
#
#   powershell -File src/win/shot.ps1 [-Dialog] [-OutFile path.png]
#   -Dialog  capture the visible #32770 dialog instead of the main window
# The window's class, title, rectangle and — for a file dialog — the current
# file-name text are printed as well.
param([switch]$Dialog, [string]$OutFile)

. (Join-Path $PSScriptRoot 'devhost.ps1')

$proc = Find-DevHostProcess
if (-not $proc) {
  Write-Output 'dev host not found'
  exit 1
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DevHostShot {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

  public struct RECT { public int Left, Top, Right, Bottom; }

  private static readonly List<IntPtr> Found = new List<IntPtr>();
  private static readonly List<string> FoundInfo = new List<string>();
  private static uint[] _pids;
  private static bool _dialogOnly;

  public static IList<IntPtr> Handles { get { return Found; } }
  public static IList<string> Infos { get { return FoundInfo; } }

  public static void Find(uint[] pids, bool dialogOnly) {
    Found.Clear(); FoundInfo.Clear();
    _pids = pids; _dialogOnly = dialogOnly;
    EnumWindows(OnWindow, IntPtr.Zero);
  }

  private static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    uint pid; GetWindowThreadProcessId(hWnd, out pid);
    bool match = false;
    foreach (uint p in _pids) if (p == pid) match = true;
    if (!match || !IsWindowVisible(hWnd)) return true;
    var cls = new StringBuilder(128); GetClassName(hWnd, cls, 128);
    var title = new StringBuilder(256); GetWindowText(hWnd, title, 256);
    if (_dialogOnly && cls.ToString() != "#32770") return true;
    if (!_dialogOnly && cls.ToString() == "#32770") return true;
    Found.Add(hWnd);
    FoundInfo.Add(cls + " :: " + title);
    return true;
  }

  public static string[] WindowDescriptions() {
    var result = new List<string>();
    for (int i = 0; i < Found.Count; i++) {
      RECT r; GetWindowRect(Found[i], out r);
      string extra = "";
      if (FoundInfo[i].StartsWith("#32770")) {
        IntPtr edit = GetDlgItem(Found[i], 1148);
        var box = new StringBuilder(512); GetWindowText(edit, box, 512);
        extra = " fileNameBox=[" + box + "]";
      }
      result.Add(FoundInfo[i] + " rect=" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + extra);
    }
    return result.ToArray();
  }

  /** PrintWindow renders the window itself; the screen blit fills in what it skips. */
  public static IntPtr Capture(IntPtr hWnd, out int width, out int height, out bool printed) {
    RECT r; GetWindowRect(hWnd, out r);
    width = r.Right - r.Left; height = r.Bottom - r.Top;
    IntPtr screenDc = GetWindowDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr bmp = CreateCompatibleBitmap(screenDc, width, height);
    IntPtr old = SelectObject(memDc, bmp);
    printed = PrintWindow(hWnd, memDc, 2);
    BitBlt(memDc, 0, 0, width, height, screenDc, r.Left, r.Top, 0x00CC0020);
    SelectObject(memDc, old); DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc);
    return bmp;
  }
}
'@

$targets = [uint32[]]@([uint32]$proc.Id)
[DevHostShot]::Find($targets, [bool]$Dialog)
$descriptions = [DevHostShot]::WindowDescriptions()
if ($descriptions.Count -eq 0) {
  Write-Output $(if ($Dialog) { 'no visible dialog found' } else { 'no visible dev host window found' })
  exit 1
}

$descriptions | ForEach-Object { Write-Output $_ }

$index = 0
$handle = [DevHostShot]::Handles[$index]
$width = 0
$height = 0
$printed = $false
$bitmap = [DevHostShot]::Capture($handle, [ref]$width, [ref]$height, [ref]$printed)
$image = [System.Drawing.Image]::FromHbitmap($bitmap)
if (-not $OutFile) {
  $OutFile = Join-Path (Join-Path $PSScriptRoot '..\..\shots') $(if ($Dialog) { 'winapi-dialog.png' } else { 'winapi-devhost.png' })
}
$image.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$image.Dispose()
Write-Output "saved $OutFile ($width x $height, printWindow=$printed)"
