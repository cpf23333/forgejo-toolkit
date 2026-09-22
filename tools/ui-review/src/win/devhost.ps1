# Locate the isolated dev-host window without relying on its (localized) title.
#
# Both helper scripts need the Code.exe process that owns the dev-host window.
# Matching `MainWindowTitle` only works in an English UI: with `--locale=zh-cn`
# the title is "[扩展开发宿主] …" and the scripts reported "window not found".
# Match the `--user-data-dir` of this harness instead (see launch.ts) and fall
# back to the English title for a host started some other way.
function Find-DevHostProcess {
  $marker = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  $candidates = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$marker*" -and $_.CommandLine -notlike '*--type=*' }
  foreach ($candidate in $candidates) {
    $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      return $process
    }
  }
  return Get-Process Code -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match 'Extension Development Host' } |
    Select-Object -First 1
}
