<#
.SYNOPSIS
  find_sym.sh 的 Windows PowerShell 等价脚本。

.DESCRIPTION
  Linux 版（tools/find_sym.sh）通过 apt-get 安装依赖后，用 nm -D 在
  /usr/lib/x86_64-linux-gnu/libTK*.so 中 grep 目标符号；本脚本在 Windows 上
  遍历 OCCT 运行时 bin 目录下的 TK*.dll，用 dumpbin /exports 导出符号表并匹配。

.PARAMETER Pattern
  要查找的符号子串，默认 BRepMesh_IncrementalMeshC。

.PARAMETER SearchRoot
  OCCT 运行时 DLL 所在目录；默认取 $env:OCCT_DIR\bin。

.NOTES
  dumpbin.exe 随 Visual Studio Build Tools / Visual Studio 提供，
  不在 PATH 时请在 Developer PowerShell 中运行，或安装 Build Tools。
#>
param(
  [string]$Pattern = 'BRepMesh_IncrementalMeshC',
  [string]$SearchRoot = $(if ($env:OCCT_DIR) { Join-Path $env:OCCT_DIR 'bin' } else { '' })
)

if (-not (Get-Command dumpbin.exe -ErrorAction SilentlyContinue)) {
  Write-Error '未找到 dumpbin.exe：请安装 Visual Studio Build Tools 并在 Developer PowerShell 中运行。'
  exit 1
}

if ([string]::IsNullOrEmpty($SearchRoot) -or -not (Test-Path $SearchRoot)) {
  Write-Error "OCCT bin 目录不存在：$SearchRoot （设置 `$env:OCCT_DIR 或用 -SearchRoot 指定）"
  exit 1
}

Get-ChildItem -Path $SearchRoot -Filter 'TK*.dll' | ForEach-Object {
  $hits = dumpbin /exports $_.FullName |
    Select-String -SimpleMatch $Pattern |
    Select-Object -First 5
  if ($hits) {
    Write-Host "== $($_.FullName)"
    $hits | ForEach-Object { Write-Host $_.Line.Trim() }
  }
}
