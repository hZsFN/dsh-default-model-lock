param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop",
  [Parameter(Mandatory = $true)][string]$BackupDir
)
$ErrorActionPreference = 'Stop'

$srcPkg = Join-Path $BackupDir 'package.json'
$srcPatch = Join-Path $BackupDir 'cordis.patch.yml'
foreach ($p in @($srcPkg, $srcPatch)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "备份不完整，缺少 $p" }
}

$pkgPath = Join-Path $Profile 'package.json'
$patchPath = Join-Path $Profile 'cordis.patch.yml'
$target = Join-Path (Join-Path $Profile 'node_modules') 'dsh-model-lock'

Copy-Item -LiteralPath $srcPkg -Destination $pkgPath -Force
Copy-Item -LiteralPath $srcPatch -Destination $patchPath -Force
Write-Host "已还原 package.json 与 cordis.patch.yml（来自 $BackupDir）"

if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.LinkType) {
    # 只删链接本身，绝不递归删除目标目录
    [System.IO.Directory]::Delete($target, $false)
    Write-Host "已移除 junction: $target（插件源码目录未动）"
  } else {
    Write-Host "⚠ $target 不是链接，已保留，请人工确认。"
  }
}

Write-Host '重载/重启 DSH 后生效。'
