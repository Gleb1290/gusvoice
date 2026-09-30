fn main() {
    // 🔴 `nvcuda.dll` — только ОТЛОЖЕННЫЙ импорт.
    //
    // Вендоренный webrtc-sys с NVENC линкует `cuda.lib` (драйверный API CUDA), и без этого флага
    // `nvcuda.dll` попадал в ОБЫЧНЫЙ импорт `gusvoice.exe`. А эта библиотека ставится только с
    // драйвером NVIDIA: на машине с AMD или встроенной графикой Windows отказывался запускать
    // приложение вовсе («система не обнаружила nvcuda.dll») — с 29.06, когда в сборку вошёл NVENC,
    // и до 23.09, когда на это наткнулся первый человек без NVIDIA.
    //
    // Код к машине без NVIDIA был готов всегда: `CudaContext::IsAvailable()` сначала пробует
    // `LoadLibrary("nvcuda.dll")` и только потом зовёт CUDA, а без библиотеки остаётся программный
    // H.264. Не хватало именно отложенной загрузки — её и включаем. Флаг ставится ЗДЕСЬ, а не в
    // build.rs webrtc-sys: `rustc-link-arg` зависимости до итогового exe не доезжает.
    // Страж — `scripts/check-exe-imports.mjs` в джобе `windows`.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-env-changed=GV_CUDA_DIR");
        // Без GV_CUDA_DIR webrtc-sys собирается без NVENC и `cuda.lib` не линкует — флаг был бы
        // про несуществующий импорт (предупреждение LNK4199).
        if std::env::var_os("GV_CUDA_DIR").is_some() {
            println!("cargo:rustc-link-arg=/DELAYLOAD:nvcuda.dll");
            // Помощник отложенной загрузки (`__delayLoadHelper2`) живёт здесь.
            println!("cargo:rustc-link-arg=delayimp.lib");
        }
    }
    tauri_build::build();
}
