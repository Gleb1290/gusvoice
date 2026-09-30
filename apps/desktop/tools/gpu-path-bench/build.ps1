# Сборка gpu-path-bench (#207, шаг 4.0). Отдельно от приложения: cargo и CI его не трогают.
#
# Нужны:
# - Visual Studio Build Tools с C++ (тот же cl.exe, что собирает десктоп);
# - архив cuda_cudart (include\cuda.h, lib\x64\cuda.lib) — как в CI, через GV_CUDA_DIR;
# - prebuilt libwebrtc от LiveKit: из него берётся libyuv, ТОТ ЖЕ, что переводит кадр в приложении.
#   Появляется после любой cargo-сборки десктопа; ищется в src-tauri\target сам.
#
# pwsh -File build.ps1 [-CudaDir …] [-WebrtcDir …\win-x64-release]
param(
    [string]$CudaDir = $env:GV_CUDA_DIR,
    [string]$WebrtcDir = $env:GV_WEBRTC_DIR
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$desktop = (Resolve-Path "$here\..\..").Path

if (-not $CudaDir -or -not (Test-Path "$CudaDir\include\cuda.h")) {
    throw 'Нужен архив cuda_cudart: -CudaDir или GV_CUDA_DIR (include\cuda.h, lib\x64\cuda.lib)'
}
if (-not $WebrtcDir) {
    $found = Get-ChildItem "$desktop\src-tauri\target" -Recurse -Directory -Filter 'win-x64-release' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path "$($_.FullName)\lib\webrtc.lib" } | Select-Object -First 1
    if (-not $found) { throw 'Не нашёл prebuilt libwebrtc: собери десктоп (cargo build) или укажи -WebrtcDir' }
    $WebrtcDir = $found.FullName
}
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Не нашёл Visual Studio с C++' }

$nv = "$desktop\vendor\webrtc-sys\src\nvidia\NvCodec"
$out = "$here\build"
New-Item -ItemType Directory -Force $out | Out-Null

# /MT — статический CRT: prebuilt libwebrtc собран с ним (см. src-tauri\.cargo\config.toml).
$cl = @(
    '/nologo', '/std:c++20', '/O2', '/MT', '/EHsc', '/W3', '/utf-8', '/wd4996',
    '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN',
    "/I$nv\include", "/I$nv\NvCodec", "/I$CudaDir\include", "/I$WebrtcDir\include\third_party\libyuv\include",
    "$here\bench.cpp", "$nv\NvCodec\NvEncoder\NvEncoder.cpp", "$nv\NvCodec\NvEncoder\NvEncoderCuda.cpp",
    "/Fe$out\gpu-path-bench.exe",
    '/link', "/LIBPATH:$CudaDir\lib\x64", "/LIBPATH:$WebrtcDir\lib", 'cuda.lib', 'webrtc.lib', 'user32.lib'
) | ForEach-Object { '"' + $_ + '"' }

Push-Location $out
try {
    cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && cl $($cl -join ' ')"
    if ($LASTEXITCODE -ne 0) { throw "cl завершился с кодом $LASTEXITCODE" }
} finally {
    Pop-Location
}
Write-Host "Готово: $out\gpu-path-bench.exe"
