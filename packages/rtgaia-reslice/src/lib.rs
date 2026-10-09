//! RT-Gaia CPU 重切核心。
//!
//! **單一來源，三處使用**：`wasm32` 供瀏覽器 Tier C、cdylib 供後端的高品質
//! 重切、以及 GPU／CPU 等效性測試。**因此不使用 wasm-bindgen 或 pyo3**
//! ——裸 `extern "C"` 讓兩個宿主看到同一組符號，等效性不會因綁定層而分岔。
//!
//! ## 錯誤約定
//!
//! 所有 FFI 函式回傳 `i32`：`>= 0` 為成功（多數為寫出的元素數），負值為錯誤碼。
//! **不 panic 跨越 FFI 邊界**（wasm 上會直接 trap，Python 上會 abort 整個行程）。

pub mod contour;
pub mod geom;
pub mod sample;

use core::slice;

use geom::GridDesc;
use sample::PlaneDesc;

pub const VERSION: u32 = 1;

pub const ERR_NULL: i32 = -1;
pub const ERR_LENGTH: i32 = -2;
pub const ERR_CAPACITY: i32 = -3;
pub const ERR_STITCH: i32 = -4;

/// wire／ABI 版本。宿主載入後第一件事就是比這個值。
#[no_mangle]
pub extern "C" fn rt_version() -> u32 {
    VERSION
}

/// 兩個 `repr(C)` 結構的位元組大小，寫進 `out[0]`／`out[1]`。
///
/// 🔴 **兩個宿主載入後都必須斷言這兩個值。** ctypes 與 wasm 的 `DataView`
/// 各自重算欄位偏移；一旦與 Rust 的 `repr(C)` 對不上，症狀是**取到別的欄位**
/// ——影像會歪掉但不會報錯，這是最貴的一類 bug。
///
/// # Safety
/// `out` 必須指向 2 個可寫的 u32。
#[no_mangle]
pub unsafe extern "C" fn rt_struct_sizes(out: *mut u32) -> i32 {
    if out.is_null() {
        return ERR_NULL;
    }
    let o = slice::from_raw_parts_mut(out, 2);
    o[0] = core::mem::size_of::<GridDesc>() as u32;
    o[1] = core::mem::size_of::<PlaneDesc>() as u32;
    0
}

// ── wasm 的記憶體管理 ───────────────────────────────────────────────────────
// 瀏覽器端需要在 wasm linear memory 裡配置緩衝區才能餵資料進來。原生（Python
// ctypes）端不需要這兩個——numpy 陣列的指標直接就能用。

/// 在 wasm linear memory 裡配置 `size` 位元組，回傳指標（8 位元組對齊）。
#[no_mangle]
pub extern "C" fn rt_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    let layout = match std::alloc::Layout::from_size_align(size, 8) {
        Ok(l) => l,
        Err(_) => return core::ptr::null_mut(),
    };
    unsafe { std::alloc::alloc(layout) }
}

/// 釋放 `rt_alloc` 配置的區塊。**`size` 必須與配置時相同。**
///
/// # Safety
/// `ptr` 必須來自 `rt_alloc`、尚未被釋放，且 `size` 與配置時完全相同。
/// 這裡標 `unsafe` 是為了與其餘 FFI 入口一致（`rt_reslice_*` 都是），
/// 匯出的符號完全不變 —— JS 與 ctypes 那一側看到的還是同一個 `rt_free`。
#[no_mangle]
pub unsafe extern "C" fn rt_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(size, 8) {
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

// ── 重切 ────────────────────────────────────────────────────────────────────

macro_rules! reslice_entry {
    ($name:ident, $ty:ty) => {
        /// 任意平面（含斜面）重切為 f32 平面。回傳寫出的像素數。
        ///
        /// # Safety
        /// 呼叫端必須保證所有指標有效、長度正確，且 `grid`／`plane` 指向對齊的結構。
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            vol: *const $ty,
            vol_len: usize,
            grid: *const GridDesc,
            plane: *const PlaneDesc,
            out: *mut f32,
            out_len: usize,
        ) -> i32 {
            if vol.is_null() || grid.is_null() || plane.is_null() || out.is_null() {
                return ERR_NULL;
            }
            let g = *grid;
            let p = *plane;
            if vol_len < g.voxel_count() {
                return ERR_LENGTH;
            }
            let need = p.out_w as usize * p.out_h as usize;
            if out_len < need {
                return ERR_CAPACITY;
            }
            let vol = slice::from_raw_parts(vol, vol_len);
            let out = slice::from_raw_parts_mut(out, need);
            sample::reslice(vol, &g, &p, out);
            need as i32
        }
    };
}

reslice_entry!(rt_reslice_i16, i16);
reslice_entry!(rt_reslice_u8, u8);
reslice_entry!(rt_reslice_f32, f32);

/// 單點世界座標取樣。**跨宿主一致性的驗收工具**：Python 端與瀏覽器端對
/// 同一個 LPS 座標取到的值必須一致。
///
/// # Safety
/// 見 `rt_reslice_i16`。`out` 必須指向一個可寫的 f32。
#[no_mangle]
pub unsafe extern "C" fn rt_sample_world_i16(
    vol: *const i16,
    vol_len: usize,
    grid: *const GridDesc,
    wx: f64,
    wy: f64,
    wz: f64,
    outside: f32,
    out: *mut f32,
) -> i32 {
    if vol.is_null() || grid.is_null() || out.is_null() {
        return ERR_NULL;
    }
    let g = *grid;
    if vol_len < g.voxel_count() {
        return ERR_LENGTH;
    }
    let vol = slice::from_raw_parts(vol, vol_len);
    *out = sample::sample_world(vol, &g, [wx, wy, wz], outside);
    0
}

// ── 顯示（LUT 與合成）──────────────────────────────────────────────────────

/// WW/WL → 8-bit 灰階。
///
/// # Safety
/// `src` 與 `out` 必須各有 `len` 個元素。
#[no_mangle]
pub unsafe extern "C" fn rt_window_to_u8(
    src: *const f32,
    len: usize,
    center: f64,
    width: f64,
    out: *mut u8,
) -> i32 {
    if src.is_null() || out.is_null() {
        return ERR_NULL;
    }
    sample::window_to_u8(
        slice::from_raw_parts(src, len),
        center,
        width,
        slice::from_raw_parts_mut(out, len),
    );
    len as i32
}

/// 灰階 → RGBA。
///
/// # Safety
/// `src` 有 `len` 個元素，`out` 有 `len * 4` 個。
#[no_mangle]
pub unsafe extern "C" fn rt_gray_to_rgba(src: *const u8, len: usize, out: *mut u8) -> i32 {
    if src.is_null() || out.is_null() {
        return ERR_NULL;
    }
    sample::gray_to_rgba(
        slice::from_raw_parts(src, len),
        slice::from_raw_parts_mut(out, len * 4),
    );
    len as i32
}

/// mask 疊圖合成（Tier C 的 fill 模式，**不做位元打包**）。
///
/// # Safety
/// `rgba` 有 `len * 4` 個元素，`mask_plane` 有 `len` 個。
#[no_mangle]
pub unsafe extern "C" fn rt_composite_mask_rgba(
    rgba: *mut u8,
    mask_plane: *const f32,
    len: usize,
    r: u8,
    g: u8,
    b: u8,
    alpha: f32,
    threshold: f32,
) -> i32 {
    if rgba.is_null() || mask_plane.is_null() {
        return ERR_NULL;
    }
    sample::composite_mask_rgba(
        slice::from_raw_parts_mut(rgba, len * 4),
        slice::from_raw_parts(mask_plane, len),
        [r, g, b],
        alpha,
        threshold,
    );
    len as i32
}

// ── 輪廓（預設 mask 渲染路徑）──────────────────────────────────────────────

/// 在取樣好的平面上求等值線。回傳 segment 數；容量不足回傳 `ERR_CAPACITY`。
///
/// # Safety
/// `field` 有 `w * h` 個元素，`out` 有 `out_len` 個 f32（每 segment 4 個）。
#[no_mangle]
pub unsafe extern "C" fn rt_marching_squares(
    field: *const f32,
    w: usize,
    h: usize,
    level: f32,
    out: *mut f32,
    out_len: usize,
) -> i32 {
    if field.is_null() || out.is_null() {
        return ERR_NULL;
    }
    match contour::marching_squares(
        slice::from_raw_parts(field, w * h),
        w,
        h,
        level,
        slice::from_raw_parts_mut(out, out_len),
    ) {
        Ok(n) => n as i32,
        Err(_) => ERR_CAPACITY,
    }
}

/// 把 segment soup 縫成 polyline。`counts` 為長度 2 的 u32 輸出：`[點數, polyline 數]`。
///
/// # Safety
/// 各緩衝區長度必須與宣告的容量相符；`counts` 必須指向 2 個可寫的 u32。
#[no_mangle]
pub unsafe extern "C" fn rt_stitch_polylines(
    segments: *const f32,
    seg_count: usize,
    out_xy: *mut f32,
    out_xy_len: usize,
    out_lens: *mut u32,
    out_lens_len: usize,
    counts: *mut u32,
) -> i32 {
    if segments.is_null() || out_xy.is_null() || out_lens.is_null() || counts.is_null() {
        return ERR_NULL;
    }
    let segs = slice::from_raw_parts(segments, seg_count * contour::FLOATS_PER_SEGMENT);
    match contour::stitch(
        segs,
        seg_count,
        slice::from_raw_parts_mut(out_xy, out_xy_len),
        slice::from_raw_parts_mut(out_lens, out_lens_len),
    ) {
        Ok((pts, lines)) => {
            let c = slice::from_raw_parts_mut(counts, 2);
            c[0] = pts as u32;
            c[1] = lines as u32;
            0
        }
        Err(_) => ERR_STITCH,
    }
}

/// 一次做完「取樣平面 → 求輪廓」——**outline 模式每幀走的就是這條路**。
///
/// 合成一個入口的理由不是方便，而是**避免中間的 f32 平面跨越 FFI 邊界**：
/// 20 個結構 × 512² × 4 bytes = 21 MB／幀的來回複製，會把效能預算吃光。
///
/// # Safety
/// 見各個別函式。`scratch` 需有 `plane.out_w * plane.out_h` 個 f32。
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn rt_mask_outline_u8(
    mask: *const u8,
    mask_len: usize,
    grid: *const GridDesc,
    plane: *const PlaneDesc,
    level: f32,
    scratch: *mut f32,
    scratch_len: usize,
    out: *mut f32,
    out_len: usize,
) -> i32 {
    let rc = rt_reslice_u8(mask, mask_len, grid, plane, scratch, scratch_len);
    if rc < 0 {
        return rc;
    }
    let p = *plane;
    rt_marching_squares(
        scratch,
        p.out_w as usize,
        p.out_h as usize,
        level,
        out,
        out_len,
    )
}
