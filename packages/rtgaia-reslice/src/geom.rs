//! 幾何：`Grid` 的 C ABI 鏡像與 index↔world 轉換。
//!
//! 這裡的數學**必須與 `rtgaia_geom.grid` 逐位元同義**（驗收條件：
//! Python 端與瀏覽器端對同一個 world 座標算出的 ijk 必須一致）。因此：
//!
//! * `direction` 一律 row-major，**第 c 欄是第 c 個索引軸的方向向量**（同 ITK）
//! * `world = origin + direction * (spacing ⊙ ijk)`
//! * 反向以 3×3 解析求逆，不用迭代法（避免兩個宿主的收斂差異）

/// `Grid` 的 C ABI 鏡像。欄位順序即 wire 順序，不得重排。
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct GridDesc {
    pub size: [u32; 3],
    pub spacing: [f64; 3],
    pub origin: [f64; 3],
    /// row-major 3×3 方向餘弦。
    pub direction: [f64; 9],
}

/// 3×4 仿射（row-major），world → 連續索引。
#[derive(Clone, Copy, Debug)]
pub struct Affine {
    pub m: [f64; 9],
    pub t: [f64; 3],
}

impl Affine {
    #[inline]
    pub fn apply(&self, p: [f64; 3]) -> [f64; 3] {
        [
            self.m[0] * p[0] + self.m[1] * p[1] + self.m[2] * p[2] + self.t[0],
            self.m[3] * p[0] + self.m[4] * p[1] + self.m[5] * p[2] + self.t[1],
            self.m[6] * p[0] + self.m[7] * p[1] + self.m[8] * p[2] + self.t[2],
        ]
    }
}

fn inverse3(m: &[f64; 9]) -> Option<[f64; 9]> {
    let (a, b, c, d, e, f, g, h, i) = (m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-300 {
        return None;
    }
    let inv = 1.0 / det;
    Some([
        (e * i - f * h) * inv,
        (c * h - b * i) * inv,
        (b * f - c * e) * inv,
        (f * g - d * i) * inv,
        (a * i - c * g) * inv,
        (c * d - a * f) * inv,
        (d * h - e * g) * inv,
        (b * g - a * h) * inv,
        (a * e - b * d) * inv,
    ])
}

impl GridDesc {
    /// index → world 的 3×3 部分（direction ⊙ spacing，欄縮放）。
    pub fn index_to_world_matrix(&self) -> [f64; 9] {
        let d = &self.direction;
        let s = &self.spacing;
        [
            d[0] * s[0],
            d[1] * s[1],
            d[2] * s[2],
            d[3] * s[0],
            d[4] * s[1],
            d[5] * s[2],
            d[6] * s[0],
            d[7] * s[1],
            d[8] * s[2],
        ]
    }

    pub fn index_to_world(&self, ijk: [f64; 3]) -> [f64; 3] {
        let m = self.index_to_world_matrix();
        [
            m[0] * ijk[0] + m[1] * ijk[1] + m[2] * ijk[2] + self.origin[0],
            m[3] * ijk[0] + m[4] * ijk[1] + m[5] * ijk[2] + self.origin[1],
            m[6] * ijk[0] + m[7] * ijk[1] + m[8] * ijk[2] + self.origin[2],
        ]
    }

    /// world → 連續索引的仿射。**每次重切只算一次，不進內圈。**
    pub fn world_to_index_affine(&self) -> Affine {
        let m = self.index_to_world_matrix();
        let inv = inverse3(&m).unwrap_or([0.0; 9]);
        let o = self.origin;
        let t = [
            -(inv[0] * o[0] + inv[1] * o[1] + inv[2] * o[2]),
            -(inv[3] * o[0] + inv[4] * o[1] + inv[5] * o[2]),
            -(inv[6] * o[0] + inv[7] * o[1] + inv[8] * o[2]),
        ];
        Affine { m: inv, t }
    }

    #[inline]
    pub fn voxel_count(&self) -> usize {
        self.size[0] as usize * self.size[1] as usize * self.size[2] as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_grid() -> GridDesc {
        GridDesc {
            size: [64, 64, 20],
            spacing: [1.0, 1.0, 3.0],
            origin: [-31.5, -31.5, -28.5],
            direction: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
    }

    fn tilted_grid() -> GridDesc {
        let r = 15.0_f64.to_radians();
        let (c, s) = (r.cos(), r.sin());
        GridDesc {
            direction: [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
            ..identity_grid()
        }
    }

    #[test]
    fn round_trip_identity() {
        let g = identity_grid();
        let a = g.world_to_index_affine();
        for ijk in [[0.0, 0.0, 0.0], [12.5, 3.25, 7.0], [63.0, 63.0, 19.0]] {
            let back = a.apply(g.index_to_world(ijk));
            for k in 0..3 {
                assert!((back[k] - ijk[k]).abs() < 1e-9, "{back:?} vs {ijk:?}");
            }
        }
    }

    #[test]
    fn round_trip_gantry_tilt() {
        let g = tilted_grid();
        let a = g.world_to_index_affine();
        let ijk = [10.0, 20.0, 5.0];
        let back = a.apply(g.index_to_world(ijk));
        for k in 0..3 {
            assert!((back[k] - ijk[k]).abs() < 1e-9);
        }
    }

    /// 與 Python 端同一個測試向量：傾斜 15° 時沿 k 走一步的 y 分量。
    #[test]
    fn tilt_step_matches_python() {
        let g = tilted_grid();
        let a = g.index_to_world([0.0, 0.0, 1.0]);
        let b = g.index_to_world([0.0, 0.0, 0.0]);
        let dy = a[1] - b[1];
        assert!((dy - (-3.0 * 15.0_f64.to_radians().sin())).abs() < 1e-12);
    }
}
