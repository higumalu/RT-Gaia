//! 三線性取樣與任意平面重切。

use crate::geom::{Affine, GridDesc};

/// 體素型別的統一入口。**不得為了泛型方便而先把整個 volume 轉成 f32**——
/// 那會讓 512×512×300 的 int16（157 MB）變成 314 MB，撞穿 Tier C 的配額。
pub trait Voxel: Copy {
    fn as_f32(self) -> f32;
}
impl Voxel for i16 {
    #[inline(always)]
    fn as_f32(self) -> f32 {
        self as f32
    }
}
impl Voxel for u8 {
    #[inline(always)]
    fn as_f32(self) -> f32 {
        self as f32
    }
}
impl Voxel for f32 {
    #[inline(always)]
    fn as_f32(self) -> f32 {
        self
    }
}

/// slab 的混合方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blend {
    /// 只取 slab 中心面。厚度被忽略——這是 slab 輪廓語意 A 的影像側對應。
    Center = 0,
    /// 最大強度投影。
    Mip = 1,
    /// 平均。**用於緩解非等向資料在斜面上的階梯 artifact**。
    Mean = 2,
    /// 前到後 alpha 合成，強度經 window 正規化後當不透明度。
    Composite = 3,
}

impl Blend {
    pub fn from_u32(v: u32) -> Blend {
        match v {
            1 => Blend::Mip,
            2 => Blend::Mean,
            3 => Blend::Composite,
            _ => Blend::Center,
        }
    }
}

/// 輸出平面的完整描述。
///
/// `right` / `up` 為**單位**世界方向；像素間距由 `px_mm` 給定。輸出像素 (0,0)
/// 位於左上，`origin` 是**平面中心**的世界座標（與 `ViewReference.plane_origin`
/// 一致）。
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PlaneDesc {
    pub origin: [f64; 3],
    pub right: [f64; 3],
    pub up: [f64; 3],
    pub normal: [f64; 3],
    pub out_w: u32,
    pub out_h: u32,
    pub px_mm: f64,
    pub slab_mm: f64,
    /// slab 取樣數。1 = 單一平面。**播放與互動態靠調低這個值換幀率**。
    pub slab_samples: u32,
    pub blend: u32,
    /// 落在 volume 之外時填入的值（CT 用 -1024，mask 用 0）。
    pub outside: f32,
    /// `Blend::Composite` 的 window（center, width）。其餘模式忽略。
    pub composite_window: [f64; 2],
}

#[inline(always)]
fn sample_trilinear<T: Voxel>(data: &[T], size: [u32; 3], p: [f64; 3], outside: f32) -> f32 {
    let (nx, ny, nz) = (size[0] as i64, size[1] as i64, size[2] as i64);
    // 半個體素的外擴：邊界體素的中心到邊緣之間仍應取到值，否則每張切面
    // 邊緣會少一圈——那一圈在輪廓上會表現成「結構被切掉一條邊」。
    if p[0] < -0.5 || p[1] < -0.5 || p[2] < -0.5 {
        return outside;
    }
    if p[0] > nx as f64 - 0.5 || p[1] > ny as f64 - 0.5 || p[2] > nz as f64 - 0.5 {
        return outside;
    }
    let x0 = p[0].floor();
    let y0 = p[1].floor();
    let z0 = p[2].floor();
    let clamp = |v: f64, n: i64| -> i64 {
        let i = v as i64;
        if i < 0 {
            0
        } else if i > n - 1 {
            n - 1
        } else {
            i
        }
    };
    let xi0 = clamp(x0, nx);
    let yi0 = clamp(y0, ny);
    let zi0 = clamp(z0, nz);
    // 🔴 小數部分必須用**夾過的索引**重算，不能沿用 floor 的原值。
    //
    // 上方接受範圍刻意放寬到 `[-0.5, n-0.5]`（避免每張切面邊緣少一圈），於是
    // `p = -0.05` 時 `x0 = -1`、原本的 `fx = 0.95`，而 `xi0` 被夾到 0、`xi1 = 1`
    // —— 權重因此**完全反向**：應該幾乎全取 `v[0]`，實際卻百分之九十五取了 `v[1]`。
    // 實證（`v[0]=100`、`v[1]=0`）：p=−0.45→45、−0.25→25、−0.05→5，p=0 才回到 100。
    // 高端不受影響，因為那裡 `xi1 == xi0`，兩個取樣點相同、權重乘上零差值。
    // 症狀是**每張切面低端邊緣半個體素內強度倒轉**，在輪廓上表現成邊緣鋸齒；
    // 而 WASM 與原生是同一份程式碼，等效性測試比的是兩個同樣錯的實作。
    let fx = (p[0] - xi0 as f64).clamp(0.0, 1.0) as f32;
    let fy = (p[1] - yi0 as f64).clamp(0.0, 1.0) as f32;
    let fz = (p[2] - zi0 as f64).clamp(0.0, 1.0) as f32;
    let xi1 = if xi0 + 1 > nx - 1 { xi0 } else { xi0 + 1 };
    let yi1 = if yi0 + 1 > ny - 1 { yi0 } else { yi0 + 1 };
    let zi1 = if zi0 + 1 > nz - 1 { zi0 } else { zi0 + 1 };
    let row = nx as usize;
    let slice = (nx * ny) as usize;
    let idx =
        |x: i64, y: i64, z: i64| -> usize { z as usize * slice + y as usize * row + x as usize };
    let c000 = data[idx(xi0, yi0, zi0)].as_f32();
    let c100 = data[idx(xi1, yi0, zi0)].as_f32();
    let c010 = data[idx(xi0, yi1, zi0)].as_f32();
    let c110 = data[idx(xi1, yi1, zi0)].as_f32();
    let c001 = data[idx(xi0, yi0, zi1)].as_f32();
    let c101 = data[idx(xi1, yi0, zi1)].as_f32();
    let c011 = data[idx(xi0, yi1, zi1)].as_f32();
    let c111 = data[idx(xi1, yi1, zi1)].as_f32();
    let c00 = c000 + (c100 - c000) * fx;
    let c10 = c010 + (c110 - c010) * fx;
    let c01 = c001 + (c101 - c001) * fx;
    let c11 = c011 + (c111 - c011) * fx;
    let c0 = c00 + (c10 - c00) * fy;
    let c1 = c01 + (c11 - c01) * fy;
    c0 + (c1 - c0) * fz
}

/// 公開的單點取樣（等效性測試與跨宿主一致性的驗收用）。
pub fn sample_world<T: Voxel>(data: &[T], grid: &GridDesc, world: [f64; 3], outside: f32) -> f32 {
    let a = grid.world_to_index_affine();
    sample_trilinear(data, grid.size, a.apply(world), outside)
}

/// 任意平面（含斜面）重切。輸出 f32，長度必須為 `out_w * out_h`。
pub fn reslice<T: Voxel>(data: &[T], grid: &GridDesc, plane: &PlaneDesc, out: &mut [f32]) {
    let w = plane.out_w as usize;
    let h = plane.out_h as usize;
    debug_assert_eq!(out.len(), w * h);
    let affine: Affine = grid.world_to_index_affine();
    let blend = Blend::from_u32(plane.blend);
    let samples = plane.slab_samples.max(1) as usize;
    let (cx, cy) = ((w as f64 - 1.0) * 0.5, (h as f64 - 1.0) * 0.5);
    // slab 取樣位置：以中心面為 0，對稱分布。samples == 1 時恆為中心面。
    let step = if samples > 1 {
        plane.slab_mm / (samples as f64 - 1.0)
    } else {
        0.0
    };
    let start = if samples > 1 {
        -plane.slab_mm * 0.5
    } else {
        0.0
    };
    let (wc, ww) = (
        plane.composite_window[0],
        plane.composite_window[1].max(1e-6),
    );

    for y in 0..h {
        let dy = y as f64 - cy;
        for x in 0..w {
            let dx = x as f64 - cx;
            let base = [
                plane.origin[0]
                    + plane.right[0] * dx * plane.px_mm
                    + plane.up[0] * dy * plane.px_mm,
                plane.origin[1]
                    + plane.right[1] * dx * plane.px_mm
                    + plane.up[1] * dy * plane.px_mm,
                plane.origin[2]
                    + plane.right[2] * dx * plane.px_mm
                    + plane.up[2] * dy * plane.px_mm,
            ];
            let value = match blend {
                Blend::Center => {
                    sample_trilinear(data, grid.size, affine.apply(base), plane.outside)
                }
                Blend::Mip => {
                    let mut acc = f32::NEG_INFINITY;
                    for s in 0..samples {
                        let off = start + step * s as f64;
                        let p = [
                            base[0] + plane.normal[0] * off,
                            base[1] + plane.normal[1] * off,
                            base[2] + plane.normal[2] * off,
                        ];
                        let v = sample_trilinear(data, grid.size, affine.apply(p), plane.outside);
                        if v > acc {
                            acc = v;
                        }
                    }
                    acc
                }
                Blend::Mean => {
                    let mut acc = 0.0f32;
                    for s in 0..samples {
                        let off = start + step * s as f64;
                        let p = [
                            base[0] + plane.normal[0] * off,
                            base[1] + plane.normal[1] * off,
                            base[2] + plane.normal[2] * off,
                        ];
                        acc += sample_trilinear(data, grid.size, affine.apply(p), plane.outside);
                    }
                    acc / samples as f32
                }
                Blend::Composite => {
                    let mut color = 0.0f32;
                    let mut remaining = 1.0f32;
                    for s in 0..samples {
                        let off = start + step * s as f64;
                        let p = [
                            base[0] + plane.normal[0] * off,
                            base[1] + plane.normal[1] * off,
                            base[2] + plane.normal[2] * off,
                        ];
                        let v = sample_trilinear(data, grid.size, affine.apply(p), plane.outside);
                        let norm = (((v as f64 - (wc - ww * 0.5)) / ww) as f32).clamp(0.0, 1.0);
                        let alpha = norm * (1.0 / samples as f32) * 4.0;
                        let alpha = alpha.clamp(0.0, 1.0);
                        color += remaining * alpha * v;
                        remaining *= 1.0 - alpha;
                        if remaining < 1e-3 {
                            break;
                        }
                    }
                    color + remaining * plane.outside
                }
            };
            out[y * w + x] = value;
        }
    }
}

/// WW/WL → 8-bit 灰階（Tier C 在合成時套用 LUT）。
pub fn window_to_u8(src: &[f32], center: f64, width: f64, out: &mut [u8]) {
    debug_assert_eq!(src.len(), out.len());
    let w = width.max(1e-6);
    let lo = center - w * 0.5;
    // 🔴 先除後乘，不預先算 scale = 255/w。
    // `(v - lo) / w` 對「正好在 window 中心」這個最常見的情況是**精確的 0.5**，
    // 乘 255 後為 127.5，四捨五入穩定得到 128。預先算 scale 會讓 0.6375 這類
    // 無法用二進位精確表示的倍率把 127.5 壓成 127.499…，於是 GPU 與 CPU 兩條
    // 路徑差 1 LSB —— 那正是等效性測試會反覆掛掉的地方。
    for (o, s) in out.iter_mut().zip(src.iter()) {
        let v = ((*s as f64 - lo) / w * 255.0).round();
        *o = if v <= 0.0 {
            0
        } else if v >= 255.0 {
            255
        } else {
            v as u8
        };
    }
}

/// 灰階 → RGBA（CPU 合成器的底圖）。
pub fn gray_to_rgba(src: &[u8], out: &mut [u8]) {
    debug_assert_eq!(src.len() * 4, out.len());
    for (i, g) in src.iter().enumerate() {
        out[i * 4] = *g;
        out[i * 4 + 1] = *g;
        out[i * 4 + 2] = *g;
        out[i * 4 + 3] = 255;
    }
}

/// mask 疊圖合成 —— **Tier C 的 fill 模式，直接疊，不做位元打包**。
///
/// 位元打包解的是「GPU 的 render pass 數量」，CPU 合成器沒有這個問題。
pub fn composite_mask_rgba(
    rgba: &mut [u8],
    mask_plane: &[f32],
    color: [u8; 3],
    alpha: f32,
    threshold: f32,
) {
    debug_assert_eq!(mask_plane.len() * 4, rgba.len());
    let a = alpha.clamp(0.0, 1.0);
    for (i, m) in mask_plane.iter().enumerate() {
        if *m < threshold {
            continue;
        }
        for c in 0..3 {
            let dst = rgba[i * 4 + c] as f32;
            rgba[i * 4 + c] = (dst * (1.0 - a) + color[c] as f32 * a).round() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::GridDesc;

    fn grid() -> GridDesc {
        GridDesc {
            size: [4, 4, 4],
            spacing: [1.0, 1.0, 1.0],
            origin: [0.0, 0.0, 0.0],
            direction: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
    }

    #[test]
    fn samples_exact_voxel_centers() {
        let mut v = vec![0i16; 64];
        // `1 * 4` 刻意保留：這是 k*slice + j*row + i 的展開，化簡成 4 就看不出
        // 它是「j = 1」。
        #[allow(clippy::identity_op)]
        let idx = 2 * 16 + 1 * 4 + 3; // (i,j,k) = (3,1,2)
        v[idx] = 1000;
        let g = grid();
        assert_eq!(sample_world(&v, &g, [3.0, 1.0, 2.0], -1024.0), 1000.0);
        assert_eq!(sample_world(&v, &g, [0.0, 0.0, 0.0], -1024.0), 0.0);
    }

    #[test]
    fn interpolates_midpoint() {
        let mut v = vec![0f32; 64];
        v[0] = 0.0;
        v[1] = 100.0; // (1,0,0)
        let g = grid();
        let mid = sample_world(&v, &g, [0.5, 0.0, 0.0], 0.0);
        assert!((mid - 50.0).abs() < 1e-4, "{mid}");
    }

    /// 🔴 半體素外擴區（`p ∈ (−0.5, 0)`）的權重方向。
    ///
    /// 這條抓的是「夾了索引卻沒夾小數」：修正前 p=−0.05 給 5.0（幾乎全取 `v[1]`），
    /// 也就是**越靠近 `v[0]` 反而越不像 `v[0]`**。合成假體抓不到，因為它們的邊緣
    /// 都是空氣對空氣。
    #[test]
    fn low_end_half_voxel_margin_weights_toward_the_edge_voxel() {
        let mut v = vec![0f32; 64];
        v[0] = 100.0; // (0,0,0)
        v[1] = 0.0; // (1,0,0)
        let g = grid();
        // 外擴區內一律回傳邊緣體素的值：夾住的索引兩端都是 v[0]..v[1]，但
        // 小數被夾到 0 → 純粹取 v[0]
        for p in [-0.45, -0.25, -0.05] {
            let got = sample_world(&v, &g, [p, 0.0, 0.0], 0.0);
            assert!(
                (got - 100.0).abs() < 1e-4,
                "p={p} 落在低端外擴區，應取邊緣體素 100，實得 {got}"
            );
        }
        // 邊界內側仍照常內插
        assert!((sample_world(&v, &g, [0.0, 0.0, 0.0], 0.0) - 100.0).abs() < 1e-4);
        assert!((sample_world(&v, &g, [0.5, 0.0, 0.0], 0.0) - 50.0).abs() < 1e-4);
    }

    /// 低端外擴區在**三個軸上**都要對——只修 x 是最容易犯的半套修法。
    #[test]
    fn low_end_margin_holds_on_every_axis() {
        let g = grid();
        for axis in 0..3 {
            let mut v = vec![0f32; 64];
            v[0] = 100.0;
            // 沿該軸的下一個體素設成 0（已是 0），確認取到的是 v[0] 而非它
            let mut p = [0.0f64; 3];
            p[axis] = -0.3;
            let got = sample_world(&v, &g, p, 0.0);
            assert!((got - 100.0).abs() < 1e-4, "axis={axis} 得到 {got}");
        }
    }

    /// 高端外擴區（`p ∈ (n-1, n-0.5)`）本來就對，這條是防回歸的對照。
    #[test]
    fn high_end_half_voxel_margin_is_unchanged() {
        let mut v = vec![0f32; 64];
        v[3] = 100.0; // (3,0,0)，nx = 4 → 最後一格
        let g = grid();
        for p in [3.0, 3.25, 3.45] {
            let got = sample_world(&v, &g, [p, 0.0, 0.0], 0.0);
            assert!((got - 100.0).abs() < 1e-4, "p={p} 得到 {got}");
        }
        // 超出 n-0.5 才算 outside
        assert_eq!(sample_world(&v, &g, [3.6, 0.0, 0.0], -1024.0), -1024.0);
    }

    #[test]
    fn outside_returns_fill_value() {
        let v = vec![0i16; 64];
        let g = grid();
        assert_eq!(sample_world(&v, &g, [-10.0, 0.0, 0.0], -1024.0), -1024.0);
    }

    #[test]
    fn mip_picks_maximum_through_slab() {
        let mut v = vec![0f32; 64];
        v[2 * 16] = 500.0; // k=2 平面上的一點
        let g = grid();
        let plane = PlaneDesc {
            origin: [0.0, 0.0, 0.0],
            right: [1.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            normal: [0.0, 0.0, 1.0],
            out_w: 1,
            out_h: 1,
            px_mm: 1.0,
            slab_mm: 6.0,
            slab_samples: 7,
            blend: Blend::Mip as u32,
            outside: 0.0,
            composite_window: [0.0, 1.0],
        };
        let mut out = vec![0f32; 1];
        reslice(&v, &g, &plane, &mut out);
        assert_eq!(out[0], 500.0);
    }

    #[test]
    fn center_mode_ignores_slab() {
        let mut v = vec![0f32; 64];
        v[2 * 16] = 500.0;
        let g = grid();
        let plane = PlaneDesc {
            origin: [0.0, 0.0, 0.0],
            right: [1.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            normal: [0.0, 0.0, 1.0],
            out_w: 1,
            out_h: 1,
            px_mm: 1.0,
            slab_mm: 6.0,
            slab_samples: 7,
            blend: Blend::Center as u32,
            outside: 0.0,
            composite_window: [0.0, 1.0],
        };
        let mut out = vec![0f32; 1];
        reslice(&v, &g, &plane, &mut out);
        assert_eq!(out[0], 0.0, "Center 必須只看中心面（語意 A）");
    }

    #[test]
    fn window_maps_center_to_mid_gray() {
        let mut out = [0u8; 3];
        window_to_u8(&[-1000.0, 40.0, 1000.0], 40.0, 400.0, &mut out);
        assert_eq!(out[0], 0);
        assert_eq!(out[1], 128);
        assert_eq!(out[2], 255);
    }
}
