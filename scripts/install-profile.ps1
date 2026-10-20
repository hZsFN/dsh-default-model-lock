param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$PluginPath = (Split-Path -Parent $PSScriptRoot),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$pkgPath = Join-Path $Profile 'package.json'
$patchPath = Join-Path $Profile 'cordis.patch.yml'
foreach ($p in @($pkgPath, $patchPath)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "找不到 $p" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $PluginPath ".install-backup\$stamp"
$insert = @"
- insert:
    - id: default-model-lock
      name: dsh-default-model-lock
      config:
        enabled: false
        provider: ''
        model: ''
        reasoningEffort: ''
"@

Write-Host "profile   : $Profile"
Write-Host "plugin    : $PluginPath"
Write-Host "backup    : $backupDir"
Write-Host "DryRun    : $($DryRun.IsPresent)"

if ($DryRun) {
  Write-Host '[dry-run] 将备份 package.json 与 cordis.patch.yml，追加 link 依赖与 insert 段，然后提示重载。'
  return
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $backupDir 'package.json') -Force
Copy-Item -LiteralPath $patchPath -Destination (Join-Path $backupDir 'cordis.patch.yml') -Force

$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$link = 'link:' + ($PluginPath -replace '\\', '/')
$existing = $pkg.dependencies.'dsh-default-model-lock'
if ($existing -eq $link) {
  Write-Host '依赖已存在且指向同一路径，跳过。'
} else {
  $pkg.dependencies | Add-Member -NotePropertyName 'dsh-default-model-lock' -NotePropertyValue $link -Force
  $pkg | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $pkgPath -Encoding utf8
  Write-Host "已写入 link 依赖: $link"
}

$patchText = Get-Content -LiteralPath $patchPath -Raw -Encoding utf8
if ($patchText -match 'dsh-default-model-lock') {
  Write-Host 'cordis.patch.yml 已含该插件条目，跳过。'
} else {
  if ($patchText.Trim() -eq '[]' -or $patchText.Trim() -eq '') {
    $newPatch = $insert
  } else {
    $newPatch = $patchText.TrimEnd() + "`n" + $insert
  }
  Set-Content -LiteralPath $patchPath -Value $newPatch -Encoding utf8
  Write-Host '已追加 insert 段。'
}

$nodeModules = Join-Path $Profile 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
$target = Join-Path $nodeModules 'dsh-default-model-lock'
if (-not (Test-Path -LiteralPath $target)) {
  New-Item -ItemType Junction -Path $target -Target $PluginPath | Out-Null
  Write-Host "已建立 junction: $target"
} else {
  Write-Host 'node_modules 链接已存在，跳过。'
}

$rollback = Join-Path $PluginPath 'scripts\restore-backup.ps1'
Write-Host ''
Write-Host "完成。备份在: $backupDir"
Write-Host "回滚: pwsh -File `"$rollback`" -Profile `"$Profile`" -BackupDir `"$backupDir`""
Write-Host '重载插件后设置页会出现「默认模型锁定」；改插件源码必须重载/重启 DSH 才生效。'
