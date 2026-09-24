# Pick a file in the dev host's file dialog (Open/Save).
#
# Getting here took a long detour; the findings are worth keeping because every
# obvious approach fails on this dialog (the Common Item Dialog):
#   - SendKeys: landing is unreliable. Once the dialog is activated it can type,
#     but the last character of the path is easily dropped (`.json` arriving as
#     `.jso`), and the dialog only answers "file not found" — so a typed path must
#     be read back before using it (from the classic proxy, see below).
#   - window messages (WM_COMMAND/IDOK, BM_CLICK) and `SetWindowText` on the
#     classic `Edit` with control id 1148: no. That control is a hidden legacy
#     proxy — reading it back returns whatever was written, while the box the
#     user sees (a DirectUI one) does not follow it. This is the trap that makes
#     the dialog look like it accepted the path.
#   - UI Automation: no. Neither the box nor the buttons appear in the dialog's
#     UIA subtree.
#   - captures: `PrintWindow` (see src/win/shot.ps1) may render the DirectUI
#     file-name box empty even when it holds text, so do not use it to verify the
#     typed value.
# What works reliably:
#   1. force the dialog to the foreground by flashing it TOPMOST and attaching to
#      the foreground thread (a background process is otherwise refused);
#   2. drive it with real mouse input only, i.e. click the row of the file to
#      select and double-click it to confirm.
# To *dismiss* the dialog instead of accepting it, `-Cancel` does not touch the
# list at all: it sends the Escape keystroke to the dialog once that dialog is
# the verified foreground window (Escape is the dialog's own cancel key), then
# checks that the dialog actually closed. Double-clicking a row — what this
# script used to do on `-Cancel` — *confirms* the dialog, so a run that meant to
# dismiss silently picked the file. If Escape does not land, the window is closed
# instead (WM_CLOSE, the same as its X button) and that fallback is reported.
# Because only clicks work for selecting, the file must be in the folder the
# dialog currently shows, and its row position has to be read from a capture:
#   powershell -File src/win/shot.ps1 -Dialog       # look at the dialog
#   powershell -File src/win/fileDialog.ps1 -RowIndex 5 [-RowY 537] [-Cancel]
# `-RowY` is the screen y of the row's centre (read it off the capture); it
# defaults to the centre of the dialog's list area and is ignored with `-Cancel`.
param([int]$RowIndex = 0, [int]$RowY = 0, [switch]$Cancel)

. (Join-Path $PSScriptRoot 'devhost.ps1')

$proc = Find-DevHostProcess
if (-not $proc) {
  Write-Output 'dev host not found'
  exit 1
}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CommonDialogInput {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr Target = IntPtr.Zero;

  /** The file dialog is the widest visible #32770 of the process; error boxes are small. */
  public static IntPtr Find(uint targetPid) {
    Target = IntPtr.Zero; int bestArea = 0;
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid != targetPid || !IsWindowVisible(hWnd)) return true;
      var cls = new StringBuilder(64); GetClassName(hWnd, cls, 64);
      if (cls.ToString() != "#32770") return true;
      RECT r; GetWindowRect(hWnd, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; Target = hWnd; }
      return true;
    }, IntPtr.Zero);
    return Target;
  }

  public static string ForceForeground() {
    if (Target == IntPtr.Zero) return "no dialog";
    SetWindowPos(Target, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // HWND_TOPMOST
    SetWindowPos(Target, (IntPtr)(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // HWND_NOTOPMOST
    uint foregroundPid;
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
    uint thisThread = GetCurrentThreadId();
    AttachThreadInput(thisThread, foregroundThread, true);
    BringWindowToTop(Target);
    bool raised = SetForegroundWindow(Target);
    AttachThreadInput(thisThread, foregroundThread, false);
    System.Threading.Thread.Sleep(400);
    return "foreground=" + raised + " isForeground=" + (GetForegroundWindow() == Target);
  }

  public static int ListCentreY() {
    RECT r; GetWindowRect(Target, out r);
    return r.Top + (r.Bottom - r.Top) * 22 / 100;
  }

  public static int ListX() {
    RECT r; GetWindowRect(Target, out r);
    return r.Left + (r.Right - r.Left) * 28 / 100;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(200);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(250);
  }

  public static void DoubleClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(250);
    for (int i = 0; i < 2; i++) {
      mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
      mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(70);
    }
  }

  public static bool IsOpen() {
    return Target != IntPtr.Zero && IsWindowVisible(Target);
  }

  /** True while the dialog is the window that receives keyboard input. */
  public static bool IsForeground() {
    return Target != IntPtr.Zero && GetForegroundWindow() == Target;
  }

  /** WM_CLOSE cancels the dialog, exactly like its X button. */
  public static void Close() {
    if (Target != IntPtr.Zero) PostMessage(Target, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@

[CommonDialogInput]::Find($proc.Id) | Out-Null
Write-Output ([CommonDialogInput]::ForceForeground())

$y = $RowY
if ($y -le 0) { $y = [CommonDialogInput]::ListCentreY() }
$x = [CommonDialogInput]::ListX()
# Each row is roughly 25px apart; the list starts at the centre of the first row.
$y = $y + ($RowIndex * 25)

if ($Cancel) {
  # Dismiss the dialog. Never click a row here: a double-click on a row confirms
  # the dialog (i.e. picks the file), which is the opposite of cancelling.
  if (-not [CommonDialogInput]::IsForeground()) {
    Write-Output 'the file dialog is not the foreground window — refusing to send the cancel keystroke'
    exit 1
  }
  $wsh = New-Object -ComObject WScript.Shell
  $wsh.SendKeys('{ESC}')
  Start-Sleep -Milliseconds 600
  if (-not [CommonDialogInput]::IsOpen()) {
    Write-Output 'cancelled the file dialog (Escape)'
    exit 0
  }
  # Escape did not land (the dialog can swallow it while its file list has
  # focus). Closing the window cancels the dialog just like its X button, and
  # the fallback is reported instead of being passed off as the Escape path.
  [CommonDialogInput]::Close()
  Start-Sleep -Milliseconds 600
  if ([CommonDialogInput]::IsOpen()) {
    Write-Output 'the file dialog is still open — it did not accept Escape or WM_CLOSE; cancel it by hand'
    exit 1
  }
  Write-Output 'cancelled the file dialog (Escape did not land; closed the window instead)'
  exit 0
}

Write-Output "clicking row $RowIndex at $x,$y"
[CommonDialogInput]::Click($x, $y)
Start-Sleep -Milliseconds 300
[CommonDialogInput]::DoubleClick($x, $y)
Start-Sleep -Milliseconds 800
if ([CommonDialogInput]::IsOpen()) {
  Write-Output 'dialog still open — check the row position with src/win/shot.ps1 -Dialog'
  exit 1
}
Write-Output 'file selected'
