#Requires -Version 5.1
<#
.SYNOPSIS
    一键编译 QQ 音乐 Lite 的最新可执行版本（Windows x64）。

.DESCRIPTION
    流程：环境检查 → 结束占用中的实例（必要时）→ 安装依赖（必要时）→
          前端 Vite 构建 → Rust release 编译 → NSIS 打包 → 复制产物到 release\。

    默认产出：
      release\<产品名>_<版本>_x64-setup.exe      NSIS 安装包
      release\<产品名>_<版本>_x64_portable.exe   免安装 exe

.PARAMETER NoBundle
    只编译 exe，不生成 NSIS 安装包，速度更快。

.PARAMETER KillRunning
    检测到 qmusic-lite.exe 正在运行时直接结束，不再询问。

.PARAMETER SkipInstall
    跳过依赖检查，直接用现有 node_modules 构建。

.PARAMETER SkipBuild
    跳过编译，只把 target\release 下现有产物重新收集到 release\。

.PARAMETER Check
    构建前先跑 npm run typecheck，类型错误会中断构建。

.EXAMPLE
    .\build.ps1

.EXAMPLE
    .\build.ps1 -NoBundle -KillRunning

.EXAMPLE
    .\build.cmd
#>
[CmdletBinding()]
param(
    [switch]$NoBundle,
    [switch]$KillRunning,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Text)
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor Gray
}

function Write-Ok {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor Green
}

function Fail {
    param([string]$Text)
    Write-Host "`n[失败] $Text" -ForegroundColor Red
    exit 1
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1MB) { return ('{0:N2} MiB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KiB' -f ($Bytes / 1KB))
}

function Invoke-Npm {
    param([string[]]$Arguments)
    Write-Host "    npm $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $script:Npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "npm $($Arguments -join ' ') 失败（退出码 $LASTEXITCODE）。"
    }
}

function Get-Sha256 {
    # 不依赖 Get-FileHash（部分环境里该 cmdlet 缺失），直接用 .NET 计算；失败则返回 $null。
    param([string]$Path)
    $stream = $null
    $sha = $null
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $bytes = $sha.ComputeHash($stream)
        return ([BitConverter]::ToString($bytes) -replace '-', '')
    }
    catch {
        return $null
    }
    finally {
        if ($stream) { $stream.Dispose() }
        if ($sha) { $sha.Dispose() }
    }
}

function Copy-Artifact {
    param([string]$Source, [string]$Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $file = Get-Item -LiteralPath $Destination
    Write-Info ("{0} ({1})" -f $file.Name, (Format-Size $file.Length))
    [pscustomobject]@{
        Path = $file.FullName
        Size = $file.Length
        Hash = Get-Sha256 -Path $file.FullName
    }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root
$started = Get-Date

# ---------- 项目信息 ----------
$confPath = Join-Path $root 'apps\desktop\src-tauri\tauri.conf.json'
if (-not (Test-Path -LiteralPath $confPath)) {
    Fail "找不到 tauri.conf.json，请在仓库根目录运行本脚本：$confPath"
}

# Windows PowerShell 5.1 的 Get-Content 默认按系统 ANSI（如 gb2312）读文件，
# 会把无 BOM 的 UTF-8 配置读成乱码并让 JSON 解析失败，因此这里显式按 UTF-8 读取。
try {
    $confText = [IO.File]::ReadAllText($confPath, [Text.Encoding]::UTF8)
    $conf = $confText | ConvertFrom-Json
}
catch {
    Fail "解析 tauri.conf.json 失败：$($_.Exception.Message)"
}
$product = [string]$conf.productName
$version = [string]$conf.version
$arch = 'x64'

Write-Host "QQ 音乐 Lite 构建脚本" -ForegroundColor White
Write-Host "    仓库   : $root"
Write-Host "    版本   : $version"
Write-Host "    目标   : Windows $arch / release"
$modeText = if ($SkipBuild) { '跳过编译，仅收集现有产物' } elseif ($NoBundle) { '仅 exe（不打包）' } else { 'exe + NSIS 安装包' }
Write-Host "    模式   : $modeText"

# ---------- 环境检查 ----------
Write-Step '检查构建环境'

$required = @(
    @{ Name = 'node'; Hint = 'Node.js ≥ 22（https://nodejs.org/）' },
    @{ Name = 'npm'; Hint = 'npm ≥ 10（随 Node.js 安装）' },
    @{ Name = 'cargo'; Hint = 'Rust stable + MSVC 工具链（https://rustup.rs/）' }
)
foreach ($item in $required) {
    if (-not (Get-Command $item.Name -ErrorAction SilentlyContinue)) {
        Fail "找不到 $($item.Name)，请安装：$($item.Hint)"
    }
}

$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
$nodeVersion = (& $nodeCmd --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
Write-Ok "Node.js $nodeVersion"

if ($nodeMajor -lt 22) {
    Write-Host "    [警告] Node.js 低于 22，Vite 7 可能无法构建。" -ForegroundColor Yellow
}

$cargoCmd = (Get-Command cargo -ErrorAction SilentlyContinue).Source
Write-Ok ((& $cargoCmd --version).Trim())

$npmCmdInfo = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
if ($npmCmdInfo) {
    $script:Npm = $npmCmdInfo.Source
}
else {
    $script:Npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
}
Write-Ok "npm $(& $script:Npm --version)"

# ---------- 结束占用实例 ----------
$running = @(Get-Process -Name 'qmusic-lite' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    Write-Host "`n    [提示] QQ 音乐 Lite 正在运行（PID: $pids），运行中的 exe 会锁住编译产物。" -ForegroundColor Yellow

    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    $confirmed = $false
    if ($KillRunning) {
        $confirmed = $true
    }
    elseif ($interactive) {
        $answer = Read-Host '    现在结束它吗？(y/N)'
        $confirmed = $answer -match '^(y|yes)$'
    }

    if (-not $confirmed) {
        Fail '请先退出 QQ 音乐 Lite（含托盘图标），或加 -KillRunning 让脚本自动结束。'
    }

    $running | Stop-Process -Force
    $waited = 0
    while ((Get-Process -Name 'qmusic-lite' -ErrorAction SilentlyContinue) -and $waited -lt 5000) {
        Start-Sleep -Milliseconds 200
        $waited += 200
    }
    Start-Sleep -Milliseconds 300
    Write-Ok '已结束运行中的实例。'
}

# ---------- 依赖 ----------
Write-Step '检查依赖'

if ($SkipInstall) {
    Write-Info '已指定 -SkipInstall，跳过依赖检查。'
}
else {
    $lockPath = Join-Path $root 'package-lock.json'
    $markerPath = Join-Path $root 'node_modules\.package-lock.json'
    $needInstall = -not (Test-Path -LiteralPath $markerPath)

    if (-not $needInstall -and (Test-Path -LiteralPath $lockPath)) {
        $needInstall = (Get-Item -LiteralPath $lockPath).LastWriteTimeUtc -gt (Get-Item -LiteralPath $markerPath).LastWriteTimeUtc
    }

    if ($needInstall) {
        Write-Info '依赖缺失或 package-lock.json 已更新，执行 npm install ...'
        Invoke-Npm -Arguments @('install', '--no-audit', '--no-fund')
        Write-Ok '依赖安装完成。'
    }
    else {
        Write-Ok '依赖已就绪。'
    }
}

# ---------- 质量检查 ----------
if ($Check) {
    Write-Step '类型检查'
    Invoke-Npm -Arguments @('run', 'typecheck')
    Write-Ok '类型检查通过。'
}

# ---------- 编译 ----------
if ($SkipBuild) {
    Write-Step '跳过编译'
    Write-Info '已指定 -SkipBuild，直接收集 target\release 下的现有产物。'
}
elseif ($NoBundle) {
    Write-Step '编译 Rust release（不打包）'
    Invoke-Npm -Arguments @('run', 'tauri', '--', 'build', '--no-bundle')
}
else {
    Write-Step '编译 Rust release 并生成 NSIS 安装包'
    Invoke-Npm -Arguments @('run', 'tauri:build')
}

# ---------- 收集产物 ----------
Write-Step '收集产物'

$targetRelease = Join-Path $root 'apps\desktop\src-tauri\target\release'
$exePath = Join-Path $targetRelease 'qmusic-lite.exe'
if (-not (Test-Path -LiteralPath $exePath)) {
    Fail "未找到编译产物：$exePath"
}

$exe = Get-Item -LiteralPath $exePath
if ($exe.LastWriteTime -lt $started) {
    Write-Info 'exe 未重新链接（源码无变化），沿用上次编译结果。'
}

$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$outputs = @()
$outputs += Copy-Artifact -Source $exePath -Destination (Join-Path $outDir ("{0}_{1}_{2}_portable.exe" -f $product, $version, $arch))

if (-not $NoBundle) {
    $bundleDir = Join-Path $targetRelease 'bundle\nsis'
    $installer = Get-ChildItem -LiteralPath $bundleDir -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $installer) {
        Fail "未找到 NSIS 安装包：$bundleDir\*-setup.exe"
    }

    $outputs += Copy-Artifact -Source $installer.FullName -Destination (Join-Path $outDir ("{0}_{1}_{2}-setup.exe" -f $product, $version, $arch))
}

# ---------- 汇总 ----------
$elapsed = (Get-Date) - $started

Write-Host "`n构建完成：$product $version（$([math]::Round($elapsed.TotalMinutes, 1)) 分钟）" -ForegroundColor Green
foreach ($item in $outputs) {
    Write-Host "    $($item.Path)" -ForegroundColor White
    if ($item.Hash) {
        Write-Host "      $(Format-Size $item.Size)  SHA256 $($item.Hash)" -ForegroundColor DarkGray
    }
    else {
        Write-Host "      $(Format-Size $item.Size)" -ForegroundColor DarkGray
    }
}

if ($NoBundle) {
    Write-Host "`n    需要安装包时去掉 -NoBundle 重新运行。" -ForegroundColor DarkGray
}

exit 0
