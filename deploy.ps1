# 在 Windows 服务器上一键部署 Personal Assistant。
# 用法（服务器上任意目录 PowerShell 执行）：  powershell -ExecutionPolicy Bypass -File C:\path\to\deploy.ps1
#
# 机制（与本服务器实际部署一致）：
#   - 源码/构建：克隆/更新到 $BuildDir，npm ci + 构建前端(dist/)与后端(server/dist/)。
#   - 运行目录：$RunDir（只放产物）。后端由计划任务 $TaskName 启动：
#       run-backend.bat -> node dist\index.js（cwd=server，监听 PORT，见 server\.env）。
#   - 反代：Caddy 终止 TLS 后反代到 127.0.0.1:<PORT>。
#   - 部署=停任务 -> robocopy 覆盖 dist/、server/dist/、server/node_modules -> 启任务 -> 健康检查。
#   - server\.env 与 server\data.db 不在 git 里，部署不动它们。
#
# 前置：Node 22.5+（后端用内置 node:sqlite）、git、npm；首次需已存在 $RunDir\server\.env 和计划任务。

$ErrorActionPreference = 'Stop'
$ProgressPreference   = 'SilentlyContinue'

$RepoUrl  = 'https://github.com/from2033/plan-agent.git'
$Branch   = 'master'
$BuildDir = 'C:\pa-build'
$RunDir   = 'C:\personal-assistant'
$TaskName = 'personal-assistant'
$Port     = 8001
$rc = '/MIR','/NFL','/NDL','/NJH','/NJS','/NC','/NS','/NP'

function Run($cmd) {
  cmd /c "$cmd"
  if ($LASTEXITCODE -ne 0) { throw "命令失败 ($LASTEXITCODE): $cmd" }
}

Write-Host '==> 检查 Node 版本' -ForegroundColor Cyan
if ([int](node -p "process.versions.node.split('.')[0]") -lt 22) {
  throw "需要 Node 22.5+（当前 $(node -v)）。后端依赖内置 node:sqlite。"
}

Write-Host '==> 获取/更新源码' -ForegroundColor Cyan
if (Test-Path "$BuildDir\.git") {
  Run "git -C `"$BuildDir`" fetch --depth 1 origin $Branch"
  Run "git -C `"$BuildDir`" reset --hard origin/$Branch"
} else {
  if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
  Run "git clone --depth 1 -b $Branch $RepoUrl `"$BuildDir`""
}

Write-Host '==> 构建前端 (dist/)' -ForegroundColor Cyan
Set-Location $BuildDir
Run 'npm ci'
Run 'npm run build'

Write-Host '==> 构建后端 (server/dist/)' -ForegroundColor Cyan
Set-Location "$BuildDir\server"
Run 'npm ci'
Run 'npm run build'

Write-Host '==> 停止后端任务' -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

Write-Host '==> 覆盖产物（保留 server\.env 与 data.db）' -ForegroundColor Cyan
robocopy "$BuildDir\dist"                "$RunDir\dist"                @rc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 dist 失败 ($LASTEXITCODE)" }
robocopy "$BuildDir\server\dist"         "$RunDir\server\dist"         @rc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 server\dist 失败 ($LASTEXITCODE)" }
robocopy "$BuildDir\server\node_modules" "$RunDir\server\node_modules" @rc | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 node_modules 失败 ($LASTEXITCODE)" }

Write-Host '==> 启动后端任务' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

Write-Host '==> 健康检查' -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "http://localhost:$Port/app/api/health" -TimeoutSec 10
  Write-Host ("OK: " + ($r | ConvertTo-Json -Compress)) -ForegroundColor Green
} catch {
  Write-Warning "健康检查失败：$($_.Exception.Message)"
  Get-Content "$RunDir\server\app.log" -Tail 20
  exit 1
}
Write-Host '部署完成。公开地址：https://139-224-226-80.sslip.io/app/' -ForegroundColor Green
