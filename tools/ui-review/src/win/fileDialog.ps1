# Fill in the dev host's file dialog (Open/Save) and confirm or cancel it.
#
# `dialog.ps1`'s SendKeys approach does not reach this dialog: it is the modern
# Common Item Dialog, whose controls live in a DirectUI host, and keystrokes sent
# to the window are ignored (even `{ESC}` leaves it open). Drive it with window
# messages instead:
#   - write the path into the file-name edit (control id 1148)
#   - post WM_COMMAND/IDOK, i.e. press "Open", or WM_CLOSE to cancel
#   powershell -File src/win/fileDialog.ps1 -Path D:\path\to\file.json [-Cancel]
param([Parameter(Mandatory = $true)][string]$Path, [switch]$Cancel)

. (Join-Path $PSScriptRoot 'devhost.ps1')

$proc = Find-DevHostProcess
if (-not $proc) {
  Write-Output 'dev host not found'
  exit 1
}

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FileDialogWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool SetWindowText(IntPtr hWnd, string text);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  public static IntPtr FindDialog(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid != targetPid || !IsWindowVisible(hWnd)) return true;
      var cls = new StringBuilder(64); GetClassName(hWnd, cls, 64);
      if (cls.ToString() != "#32770") return true;
      found = hWnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindFileNameEdit(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (hWnd, l) => {
      var cls = new StringBuilder(64); GetClassName(hWnd, cls, 64);
      if (cls.ToString() == "Edit" && GetDlgCtrlID(hWnd) == 1148) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindCombo(IntPtr dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (hWnd, l) => {
      var cls = new StringBuilder(64); GetClassName(hWnd, cls, 64);
      if (cls.ToString() == "ComboBoxEx32" && GetDlgCtrlID(hWnd) == 1148) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * The dialog only enables its Open button when it observes a change on the
   * file-name control, so setting the text alone is not enough: notify it with
   * the EN_CHANGE the edit would have sent.
   */
  public static void NotifyTextChanged(IntPtr dialog, IntPtr edit) {
    const uint WM_COMMAND = 0x0111;
    const int EN_CHANGE = 0x0300;
    const int id = 1148;
    IntPtr wParam = (IntPtr)((EN_CHANGE << 16) | id);
    PostMessage(dialog, WM_COMMAND, wParam, edit);
  }

  public static void Confirm(IntPtr dialog) {
    PostMessage(dialog, 0x0111, (IntPtr)1, IntPtr.Zero); // WM_COMMAND, IDOK
  }

  public static void Cancel(IntPtr dialog) {
    PostMessage(dialog, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
  }
}
'@

$dialog = [FileDialogWin]::FindDialog($proc.Id)
if ($dialog -eq [IntPtr]::Zero) {
  Write-Output 'file dialog not found'
  exit 1
}

$edit = [FileDialogWin]::FindFileNameEdit($dialog)
if ($edit -eq [IntPtr]::Zero) {
  Write-Output 'file-name edit not found'
  exit 1
}

[FileDialogWin]::SetWindowText($edit, $Path) | Out-Null
$combo = [FileDialogWin]::FindCombo($dialog)
if ($combo -ne [IntPtr]::Zero) {
  [FileDialogWin]::SetWindowText($combo, $Path) | Out-Null
}
[FileDialogWin]::NotifyTextChanged($dialog, $edit) | Out-Null
Start-Sleep -Milliseconds 400
if ($Cancel) {
  [FileDialogWin]::Cancel($dialog) | Out-Null
  Write-Output "cancelled the file dialog"
} else {
  [FileDialogWin]::Confirm($dialog) | Out-Null
  Write-Output "selected $Path"
}
