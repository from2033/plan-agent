# 在 Windows 服务器上一键部署：拉取最新代码 → 构建前端+后端 → 重启服务。
# 用法（在服务器、仓库根目录下 PowerShell 执行）：  .\deploy.ps1
# 前置条件：
#   1) 已 git clone 本仓库到服务器，且本目录就是仓库根。
#   2) 已装 Node 22.5+（后端用到内置 node:sqlite，Node 20 跑不起来）。
#   3) 已存在 .env（前端构建用）与 server\.env（含 ACCESS_TOKEN / ANTHROPIC_API_KEY）——
#      这两个文件不在 git 里，首次部署需手动放好。
#   4) 后端注册成了名为 PersonalAssistant 的 NSSM 服务（见 DEPLOY.md）。

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "==> 检查 Node 版本" -ForegroundColor Cyan
$nodeMajor = (node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 22) {
  throw "需要 Node 22.5+（当前 v$(node -v)）。后端依赖内置 node:sqlite。"
}

Write-Host "==> 拉取最新代码" -ForegroundColor Cyan
git pull --ff-only

Write-Host "==> 构建前端 (dist/)" -ForegroundColor Cyan
npm ci
npm run build

Write-Host "==> 构建后端 (server/dist/)" -ForegroundColor Cyan
Push-Location server
npm ci
npm run build
Pop-Location

Write-Host "==> 重启后端服务 PersonalAssistant" -ForegroundColor Cyan
nssm restart PersonalAssistant

Write-Host "==> 健康检查" -ForegroundColor Cyan
Start-Sleep -Seconds 3
$port = if ($env:PORT) { $env:PORT } else { 8787 }
try {
  $res = Invoke-RestMethod -Uri "http://localhost:$port/app/api/health" -TimeoutSec 10
  Write-Host "OK: $($res | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Warning "健康检查失败，请查看服务日志。$_"
  exit 1
}

Write-Host "部署完成。" -ForegroundColor Green
