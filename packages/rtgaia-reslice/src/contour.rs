//! Marching squares 與輪廓縫合 —— **預設 mask 渲染路徑的關鍵路徑**。
//!
//! outline 定為預設模式之後，「捲動 20 個結構的切面時輪廓重算要多久」
//! 成為全案最脆弱的一格（三個 Tier 全部靠它）。因此這個
//! 模組的實作規則是：
//!
//! * **不在內圈配置記憶體**——輸出寫進呼叫端提供的緩衝區（前端重用 `Float32Array`）
//! * 縫合是**可選的第二步**：只畫線可以直接吃 segment soup，需要虛線／
//!   線帽連續性時才縫
//! * 座標一律是**平面像素座標**，投影到 canvas 由呼叫端的 `project()` 負責
//!   （型態 F3 的兩條渲染路徑共用同一份實作）

/// 每個 segment 4 個 f32：`x0, y0, x1, y1`。
pub const FLOATS_PER_SEGMENT: usize = 4;

#[inline(always)]
fn lerp(v0: f32, v1: f32, level: f32) -> f32 {
    let d = v1 - v0;
    if d.abs() < f32::EPSILON {
        0.5
    } else {
        ((level - v0) / d).clamp(0.0, 1.0)
    }
}

/// 在 `w × h` 的純量場上求 `level` 等值線。
///
/// 回傳寫出的 segment 數；若 `out` 容量不足，回傳 `Err(需要的 segment 數估計)`。
pub fn marching_squares(
    field: &[f32],
    w: usize,
    h: usize,
    level: f32,
    out: &mut [f32],
) -> Result<usize, usize> {
    if w < 2 || h < 2 || field.len() < w * h {
        return Ok(0);
    }
    let cap = out.len() / FLOATS_PER_SEGMENT;
    let mut n = 0usize;

    macro_rules! push {
        ($x0:expr, $y0:expr, $x1:expr, $y1:expr) => {{
            if n >= cap {
                return Err(n + 1);
            }
            let o = n * FLOATS_PER_SEGMENT;
            out[o] = $x0;
            out[o + 1] = $y0;
            out[o + 2] = $x1;
            out[o + 3] = $y1;
            n += 1;
        }};
    }

    for y in 0..h - 1 {
        let row0 = y * w;
        let row1 = row0 + w;
        for x in 0..w - 1 {
            let a = field[row0 + x];
            let b = field[row0 + x + 1];
            let c = field[row1 + x + 1];
            let d = field[row1 + x];
            let mut case = 0u8;
            if a >= level {
                case |= 1;
            }
            if b >= level {
                case |= 2;
            }
            if c >= level {
                case |= 4;
            }
            if d >= level {
                case |= 8;
            }
            if case == 0 || case == 15 {
                continue;
            }
            let fx = x as f32;
            let fy = y as f32;
            // 四條邊上的交點（僅在需要時才算）
            let top = || (fx + lerp(a, b, level), fy);
            let right = || (fx + 1.0, fy + lerp(b, c, level));
            let bottom = || (fx + lerp(d, c, level), fy + 1.0);
            let left = || (fx, fy + lerp(a, d, level));

            match case {
                1 | 14 => {
                    let (tx, ty) = top();
                    let (lx, ly) = left();
                    push!(tx, ty, lx, ly);
                }
                2 | 13 => {
                    let (tx, ty) = top();
                    let (rx, ry) = right();
                    push!(tx, ty, rx, ry);
                }
                3 | 12 => {
                    let (lx, ly) = left();
                    let (rx, ry) = right();
                    push!(lx, ly, rx, ry);
                }
                4 | 11 => {
                    let (rx, ry) = right();
                    let (bx, by) = bottom();
                    push!(rx, ry, bx, by);
                }
                6 | 9 => {
                    let (tx, ty) = top();
                    let (bx, by) = bottom();
                    push!(tx, ty, bx, by);
                }
                7 | 8 => {
                    let (lx, ly) = left();
                    let (bx, by) = bottom();
                    push!(lx, ly, bx, by);
                }
                // 🔴 鞍點（saddle）：一個 cell 裡兩條線，接法有兩種且視覺差異明顯。
                // 以 cell 中心值裁決，這是標準做法，也讓相鄰 cell 的接法一致。
                5 => {
                    let center = (a + b + c + d) * 0.25;
                    let (tx, ty) = top();
                    let (rx, ry) = right();
                    let (bx, by) = bottom();
                    let (lx, ly) = left();
                    if center >= level {
                        push!(tx, ty, rx, ry);
                        push!(lx, ly, bx, by);
                    } else {
                        push!(tx, ty, lx, ly);
                        push!(rx, ry, bx, by);
                    }
                }
                10 => {
                    let center = (a + b + c + d) * 0.25;
                    let (tx, ty) = top();
                    let (rx, ry) = right();
                    let (bx, by) = bottom();
                    let (lx, ly) = left();
                    if center >= level {
                        push!(tx, ty, lx, ly);
                        push!(rx, ry, bx, by);
                    } else {
                        push!(tx, ty, rx, ry);
                        push!(lx, ly, bx, by);
                    }
                }
                _ => unreachable!(),
            }
        }
    }
    Ok(n)
}

const QUANT: f32 = 4096.0;

#[inline(always)]
fn key(x: f32, y: f32) -> u64 {
    let xi = (x * QUANT).round() as i32;
    let yi = (y * QUANT).round() as i32;
    ((xi as u32 as u64) << 32) | (yi as u32 as u64)
}

/// 把 segment soup 縫成 polyline。
///
/// 回傳 `(點數, polyline 數)`。`out_xy` 依序存放各 polyline 的點（x, y 交錯），
/// `out_lens` 存放每條 polyline 的**點數**（不是 float 數）。
///
/// 縫合失敗（容量不足）回傳 `Err`。**縫合是可選的**：只 `stroke()` 的話直接吃
/// segment soup 即可，跳過這一步。
pub fn stitch(
    segments: &[f32],
    seg_count: usize,
    out_xy: &mut [f32],
    out_lens: &mut [u32],
) -> Result<(usize, usize), &'static str> {
    use std::collections::HashMap;

    let mut adjacency: HashMap<u64, Vec<usize>> = HashMap::with_capacity(seg_count * 2);
    for s in 0..seg_count {
        let o = s * FLOATS_PER_SEGMENT;
        adjacency
            .entry(key(segments[o], segments[o + 1]))
            .or_default()
            .push(s);
        adjacency
            .entry(key(segments[o + 2], segments[o + 3]))
            .or_default()
            .push(s);
    }
    let mut used = vec![false; seg_count];
    let mut pt_count = 0usize;
    let mut line_count = 0usize;

    for start in 0..seg_count {
        if used[start] {
            continue;
        }
        used[start] = true;
        let o = start * FLOATS_PER_SEGMENT;
        let mut chain: Vec<(f32, f32)> = vec![
            (segments[o], segments[o + 1]),
            (segments[o + 2], segments[o + 3]),
        ];

        // 往後接
        loop {
            let (tx, ty) = *chain.last().unwrap();
            let Some(cands) = adjacency.get(&key(tx, ty)) else {
                break;
            };
            let mut advanced = false;
            for &s in cands {
                if used[s] {
                    continue;
                }
                let so = s * FLOATS_PER_SEGMENT;
                let (ax, ay) = (segments[so], segments[so + 1]);
                let (bx, by) = (segments[so + 2], segments[so + 3]);
                if key(ax, ay) == key(tx, ty) {
                    chain.push((bx, by));
                } else {
                    chain.push((ax, ay));
                }
                used[s] = true;
                advanced = true;
                break;
            }
            if !advanced {
                break;
            }
        }
        // 往前接
        loop {
            let (hx, hy) = *chain.first().unwrap();
            let Some(cands) = adjacency.get(&key(hx, hy)) else {
                break;
            };
            let mut advanced = false;
            for &s in cands {
                if used[s] {
                    continue;
                }
                let so = s * FLOATS_PER_SEGMENT;
                let (ax, ay) = (segments[so], segments[so + 1]);
                let (bx, by) = (segments[so + 2], segments[so + 3]);
                if key(ax, ay) == key(hx, hy) {
                    chain.insert(0, (bx, by));
                } else {
                    chain.insert(0, (ax, ay));
                }
                used[s] = true;
                advanced = true;
                break;
            }
            if !advanced {
                break;
            }
        }

        if pt_count + chain.len() > out_xy.len() / 2 {
            return Err("out_xy 容量不足");
        }
        if line_count >= out_lens.len() {
            return Err("out_lens 容量不足");
        }
        for (x, y) in &chain {
            out_xy[pt_count * 2] = *x;
            out_xy[pt_count * 2 + 1] = *y;
            pt_count += 1;
        }
        out_lens[line_count] = chain.len() as u32;
        line_count += 1;
    }
    Ok((pt_count, line_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中央一個 2×2 的方塊，輪廓應是一條閉合的 polyline。
    fn square_field() -> (Vec<f32>, usize, usize) {
        let (w, h) = (8usize, 8usize);
        let mut f = vec![0.0f32; w * h];
        for y in 3..5 {
            for x in 3..5 {
                f[y * w + x] = 1.0;
            }
        }
        (f, w, h)
    }

    #[test]
    fn empty_field_yields_nothing() {
        let f = vec![0.0f32; 64];
        let mut out = vec![0.0f32; 256];
        assert_eq!(marching_squares(&f, 8, 8, 0.5, &mut out).unwrap(), 0);
    }

    #[test]
    fn full_field_yields_nothing() {
        let f = vec![1.0f32; 64];
        let mut out = vec![0.0f32; 256];
        assert_eq!(marching_squares(&f, 8, 8, 0.5, &mut out).unwrap(), 0);
    }

    #[test]
    fn square_yields_closed_loop() {
        let (f, w, h) = square_field();
        let mut segs = vec![0.0f32; 1024];
        let n = marching_squares(&f, w, h, 0.5, &mut segs).unwrap();
        assert!(n >= 8, "segment 太少: {n}");
        let mut xy = vec![0.0f32; 4096];
        let mut lens = vec![0u32; 64];
        let (pts, lines) = stitch(&segs, n, &mut xy, &mut lens).unwrap();
        assert_eq!(lines, 1, "2×2 方塊只該有一條輪廓");
        assert_eq!(lens[0] as usize, pts);
        // 閉合：首尾同點
        let (x0, y0) = (xy[0], xy[1]);
        let (xn, yn) = (xy[(pts - 1) * 2], xy[(pts - 1) * 2 + 1]);
        assert!(
            (x0 - xn).abs() < 1e-4 && (y0 - yn).abs() < 1e-4,
            "輪廓未閉合"
        );
    }

    #[test]
    fn contour_is_at_half_level_between_voxels() {
        // 左半為 1、右半為 0 的階梯，0.5 等值線應落在 x = 3.5
        let (w, h) = (8usize, 4usize);
        let mut f = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..4 {
                f[y * w + x] = 1.0;
            }
        }
        let mut segs = vec![0.0f32; 1024];
        let n = marching_squares(&f, w, h, 0.5, &mut segs).unwrap();
        assert!(n > 0);
        for s in 0..n {
            let o = s * FLOATS_PER_SEGMENT;
            for x in [segs[o], segs[o + 2]] {
                assert!((x - 3.5).abs() < 1e-4, "交點 x = {x}，應為 3.5");
            }
        }
    }

    #[test]
    fn two_blobs_yield_two_polylines() {
        let (w, h) = (16usize, 8usize);
        let mut f = vec![0.0f32; w * h];
        for y in 3..5 {
            for x in 2..4 {
                f[y * w + x] = 1.0;
            }
            for x in 11..13 {
                f[y * w + x] = 1.0;
            }
        }
        let mut segs = vec![0.0f32; 4096];
        let n = marching_squares(&f, w, h, 0.5, &mut segs).unwrap();
        let mut xy = vec![0.0f32; 8192];
        let mut lens = vec![0u32; 64];
        let (_pts, lines) = stitch(&segs, n, &mut xy, &mut lens).unwrap();
        assert_eq!(lines, 2, "兩個分離的分量必須是兩條輪廓（多連通分量）");
    }

    #[test]
    fn capacity_overflow_is_reported() {
        let (f, w, h) = square_field();
        let mut tiny = vec![0.0f32; 4]; // 只放得下 1 個 segment
        assert!(marching_squares(&f, w, h, 0.5, &mut tiny).is_err());
    }
}
