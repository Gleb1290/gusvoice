# Протокол замера под игрой (#207, шаг 4.0): игра стоит в одной сцене, фазы идут по очереди.
#
# pwsh -File run-protocol.ps1 -Game valheim.exe [-Plan compare|isolate|pipeline] [-Seconds 90] [-Monitor 0] [-Max 2560x1440]
#
# Планы:
# - compare — без показа, cpu, gpu, cpu, gpu: нынешний путь против пути внутри видеокарты. Повтор каждого
#   режима — чтобы отличить эффект от дрейфа сцены.
# - isolate — что именно даёт игре рывки. Под Valheim 25.09 рывков стало 5 → ~55 в ОБОИХ режимах, и
#   промежутки между ними кратны секунде. Фазы: без показа; только ежесекундный опрос `GPU Engine`;
#   gpu без опроса; только захват без опроса; gpu с опросом; снова без показа (дрейф сцены).
# - pipeline — конвейер NVENC в режиме gpu: 0, 1, 2 кадра в работе сверх текущего, дважды. Под Crimson
#   Desert 26.09 без конвейера показ упирался в 45 к/с: поток ждал каждый кадр в очереди за игрой.
#
# Кадры игры пишет PresentMon (если есть), нагрузку нашего процесса и игры — сам замер. GusVoice во
# время протокола экран НЕ показывает (лучше закрыть), иначе фаза «без показа» будет с показом.
param(
    [string]$Game = 'valheim.exe',
    [ValidateSet('compare', 'isolate', 'pipeline')][string]$Plan = 'compare',
    [int]$Seconds = 90,
    [int]$Monitor = 0,
    [int]$Fps = 60,
    [string]$Max = '',  # как настройка разрешения показа, например 2560x1440; пусто — родное монитора
    [string]$PresentMon = 'C:\pm\PresentMon-2.6.0-x64.exe',
    [string]$Out = "C:\pm\bench-$(Get-Date -Format yyyyMMdd-HHmm)"
)
$ErrorActionPreference = 'Stop'
$exe = "$PSScriptRoot\build\gpu-path-bench.exe"
if (-not (Test-Path $exe)) { throw "Сначала собери: pwsh -File $PSScriptRoot\build.ps1" }
if (-not (Get-Process -Name ($Game -replace '\.exe$', '') -ErrorAction SilentlyContinue)) {
    throw "Игра $Game не запущена"
}
$pm = Test-Path $PresentMon
if (-not $pm) {
    Write-Warning "PresentMon не найден ($PresentMon): кадры игры не запишутся, будет только нагрузка. Где взять — docs/streaming-playbook/04-app-footprint-and-measuring.md, раздел B3."
}
New-Item -ItemType Directory -Force $Out | Out-Null

# Mode = $null — фаза без замера (игра одна). Engines — опрашивать ли счётчики GPU Engine раз в секунду.
$plans = @{
    compare = @(
        @{ Name = 'base' },
        @{ Name = 'cpu'; Mode = 'cpu'; Engines = 1 },
        @{ Name = 'gpu'; Mode = 'gpu'; Engines = 1 },
        @{ Name = 'cpu'; Mode = 'cpu'; Engines = 1 },
        @{ Name = 'gpu'; Mode = 'gpu'; Engines = 1 }
    )
    isolate = @(
        @{ Name = 'base' },
        @{ Name = 'poll'; Mode = 'idle'; Engines = 1 },
        @{ Name = 'gpu_nopoll'; Mode = 'gpu'; Engines = 0 },
        @{ Name = 'capture_nopoll'; Mode = 'capture'; Engines = 0 },
        @{ Name = 'gpu_poll'; Mode = 'gpu'; Engines = 1 },
        @{ Name = 'base' }
    )
    pipeline = @(
        @{ Name = 'base' },
        @{ Name = 'gpu_d0'; Mode = 'gpu'; Engines = 1; Depth = 0 },
        @{ Name = 'gpu_d1'; Mode = 'gpu'; Engines = 1; Depth = 1 },
        @{ Name = 'gpu_d2'; Mode = 'gpu'; Engines = 1; Depth = 2 },
        @{ Name = 'gpu_d0'; Mode = 'gpu'; Engines = 1; Depth = 0 },
        @{ Name = 'gpu_d1'; Mode = 'gpu'; Engines = 1; Depth = 1 },
        @{ Name = 'gpu_d2'; Mode = 'gpu'; Engines = 1; Depth = 2 }
    )
}
$phases = $plans[$Plan]
$minutes = [math]::Ceiling($phases.Count * ($Seconds + 10) / 60)
Write-Host "План $Plan`: $($phases.Count) фаз по $Seconds с, всего ~$minutes мин. Переключись в игру и стой в одной сцене. Старт через 15 с."
Start-Sleep 15

$i = 0
foreach ($ph in $phases) {
    $i++
    $name = '{0}_{1}' -f $i, $ph.Name
    Write-Host "[$i/$($phases.Count)] $($ph.Name)"
    $pmProc = $null
    if ($pm) {
        # 3 с задержки — пропустить запуск кодировщиков; запись кончается раньше замера.
        $pmArgs = @('--process_name', $Game, '--output_file', "$Out\$name.csv", '--delay', '3',
            '--timed', ($Seconds - 6), '--terminate_after_timed', '--track_gpu_video', '--stop_existing_session')
        $pmProc = Start-Process $PresentMon -ArgumentList $pmArgs -PassThru -WindowStyle Hidden
    }
    if (-not $ph.Mode) {
        Start-Sleep $Seconds
    } else {
        $benchArgs = @('--mode', $ph.Mode, '--engines', $ph.Engines, '--seconds', $Seconds, '--fps', $Fps,
            '--monitor', $Monitor, '--game', $Game, '--json', "$Out\$name.json")
        if ($Max) { $benchArgs += @('--max', $Max) }
        if ($ph.Depth) { $benchArgs += @('--depth', $ph.Depth) }
        & $exe @benchArgs *> "$Out\$name.log"
    }
    if ($pmProc) {
        $pmProc.WaitForExit()
        if (-not (Test-Path "$Out\$name.csv")) {
            Write-Warning "PresentMon не записал $name.csv — скорее всего, нет прав: группа «Performance Log Users» или админская консоль."
        }
    }
    Start-Sleep 10  # дать игре и видеокарте успокоиться между фазами
}

if ($pm -and (Get-ChildItem "$Out\*.csv" -ErrorAction SilentlyContinue)) {
    pwsh -NoProfile -File "$PSScriptRoot\..\..\..\..\docs\streaming-playbook\tools\pm-summary.ps1" -App $Game -Csv "$Out\*.csv"
}
Get-ChildItem "$Out\*.json" | ForEach-Object {
    $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
    [pscustomobject]@{
        Phase    = $_.BaseName
        Depth    = $j.depth
        Poll     = $j.engines
        CpuCore  = $j.cpu_core_pct
        TickP95  = $j.tick_ms.p95
        Late     = $j.late
        FullFps  = if ($j.layers.Count) { $j.layers[0].fps } else { $null }
        LatP50   = $j.latency_ms.p50
        LatP95   = $j.latency_ms.p95
        Our3D    = $j.gpu_ours.'3d'
        OurCopy  = $j.gpu_ours.copy
        NVENC    = $j.gpu_ours.venc
        Game3D   = $j.gpu_game_3d
    }
} | Format-Table -AutoSize
Write-Host "Всё лежит в $Out — напиши «готово»."
