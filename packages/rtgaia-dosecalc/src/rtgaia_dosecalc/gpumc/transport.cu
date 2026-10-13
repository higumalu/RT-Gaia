// GPU Monte Carlo：光子＋電子／正子耦合輸運（class II 濃縮歷史），體素幾何。
//
// 物理（說明與限制見 gpumc/__init__.py）：
//   光子  Woodcock 追蹤；光電（全部給電子）、康普頓（Klein–Nishina）、成對（能量均分近似）；不做雷利散射
//   電子  受限阻擋本領連續損失（加 Bohr 漲落、Gamma 分佈）；高於門檻的 Møller（正子用同一個公式）與制動輻射當離散事件；
//         多重散射：random hinge ＋ Wentzel 分佈（屏蔽參數對齊這一步的 1 − exp(−s／λ1)）
//   正子  停下來才互毀（兩個 0.511 MeV 光子反向、方向均勻）
// 計分：每個體素一個 64 位元整數（能量 × ESCALE）—— 整數加法跟順序無關，同一個種子結果逐位元相同。
// 亂數：每個歷史用 splitmix64(seed, 歷史編號) 起始 xoroshiro128**（不受執行緒排程影響）。

#define NQ 21
#define Q_PHOT 0
#define Q_COMPT 1
#define Q_CONV 2
#define Q_SE 3
#define Q_MOLLER 4
#define Q_BREM_E 5
#define Q_TR_E 6
#define Q_SP 7
#define Q_BHABHA 8
#define Q_BREM_P 9
#define Q_TR_P 10
#define Q_EH_E 11
#define Q_XC_E 12
#define Q_A_E 13
#define Q_TRS_E 14
#define Q_EH_P 15
#define Q_XC_P 16
#define Q_A_P 17
#define Q_TRS_P 18
#define Q_ZEFF 19
#define Q_BOHR 20

#define ME 0.51099895f
#define STACK 40
#define T_PHOTON 0
#define T_ELECTRON 1
#define T_POSITRON 2

struct Rng {
  unsigned long long s0, s1;
};

__device__ __forceinline__ unsigned long long splitmix(unsigned long long &x) {
  unsigned long long z = (x += 0x9E3779B97F4A7C15ULL);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}

__device__ __forceinline__ unsigned long long rotl(unsigned long long x, int k) { return (x << k) | (x >> (64 - k)); }

__device__ __forceinline__ float rnd(Rng &r) {
  unsigned long long s0 = r.s0, s1 = r.s1;
  unsigned long long out = rotl(s0 * 5ULL, 7) * 9ULL;
  s1 ^= s0;
  r.s0 = rotl(s0, 24) ^ s1 ^ (s1 << 16);
  r.s1 = rotl(s1, 37);
  // (0, 1)：24 位元，中心化
  return ((float)(out >> 40) + 0.5f) * (1.0f / 16777216.0f);
}

// 標準常態（Box–Muller）
__device__ __forceinline__ float gauss(Rng &r) {
  float u1 = rnd(r), u2 = rnd(r);
  return sqrtf(-2.0f * logf(u1)) * cosf(6.28318531f * u2);
}

// Gamma(k, 1)（Marsaglia–Tsang；k < 1 用 Gamma(k+1)·U^(1/k)）
__device__ float gamma_k(Rng &r, float k) {
  float boost = 1.0f;
  if (k < 1.0f) {
    boost = powf(rnd(r), 1.0f / k);
    k += 1.0f;
  }
  float d = k - 1.0f / 3.0f, c = rsqrtf(9.0f * d);
  for (int it = 0; it < 64; it++) {
    float x = gauss(r), v = 1.0f + c * x;
    if (v <= 0.0f) continue;
    v = v * v * v;
    float u = rnd(r);
    if (logf(u) < 0.5f * x * x + d - d * v + d * logf(v)) return d * v * boost;
  }
  return d * boost;
}

struct P {
  float x, y, z, u, v, w, e;
  int type;
};

struct Geo {
  int nx, ny, nz;
  float dx, dy, dz;  // mm
  float ox, oy, oz;  // 網格的角（第一個體素的外緣），mm
};

struct Tab {
  const float *t;      // [NQ][nmat][ne]
  const float *mumax;  // [ne] Woodcock 用（已乘上網格裡的最大密度比）
  const float *rho_ref;
  int nmat, ne;
  float lne0, dlne;
};

__device__ __forceinline__ float lerp_tab(const Tab &tb, int q, int m, float e) {
  float f = (logf(e) - tb.lne0) / tb.dlne;
  f = fminf(fmaxf(f, 0.0f), (float)(tb.ne - 1) - 1e-3f);
  int i = (int)f;
  float a = f - (float)i;
  const float *row = tb.t + ((size_t)q * tb.nmat + m) * tb.ne;
  return row[i] + a * (row[i + 1] - row[i]);
}

__device__ __forceinline__ float lerp_mumax(const Tab &tb, float e) {
  float f = (logf(e) - tb.lne0) / tb.dlne;
  f = fminf(fmaxf(f, 0.0f), (float)(tb.ne - 1) - 1e-3f);
  int i = (int)f;
  float a = f - (float)i;
  // 線性內插不保證上界：放大 1% 當安全邊際
  return fmaxf(tb.mumax[i], tb.mumax[i + 1]) * 1.01f + 0.0f * a;
}

__device__ __forceinline__ int voxel(const Geo &g, float x, float y, float z) {
  int i = (int)floorf((x - g.ox) / g.dx), j = (int)floorf((y - g.oy) / g.dy), k = (int)floorf((z - g.oz) / g.dz);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return -1;
  return (k * g.ny + j) * g.nx + i;
}

// 從 (x,y,z) 沿方向 (u,v,w) 到目前體素邊界的距離
__device__ __forceinline__ float to_boundary(const Geo &g, float x, float y, float z, float u, float v, float w) {
  float fx = (x - g.ox) / g.dx, fy = (y - g.oy) / g.dy, fz = (z - g.oz) / g.dz;
  float t = 1e30f;
  if (u > 1e-9f) t = fminf(t, (floorf(fx) + 1.0f - fx) * g.dx / u);
  else if (u < -1e-9f) t = fminf(t, (fx - floorf(fx)) * g.dx / -u);
  if (v > 1e-9f) t = fminf(t, (floorf(fy) + 1.0f - fy) * g.dy / v);
  else if (v < -1e-9f) t = fminf(t, (fy - floorf(fy)) * g.dy / -v);
  if (w > 1e-9f) t = fminf(t, (floorf(fz) + 1.0f - fz) * g.dz / w);
  else if (w < -1e-9f) t = fminf(t, (fz - floorf(fz)) * g.dz / -w);
  return t;
}

__device__ __forceinline__ void deposit(unsigned long long *edep, int vox, float e, float escale) {
  if (vox >= 0 && e > 0.0f) atomicAdd(edep + vox, (unsigned long long)llrintf(e * escale));
}

// 把方向 (u,v,w) 轉一個極角 (cos θ) 與方位角 φ
__device__ void rotate(float &u, float &v, float &w, float cost, float phi) {
  float sint = sqrtf(fmaxf(0.0f, 1.0f - cost * cost));
  float cp = cosf(phi), sp = sinf(phi);
  if (fabsf(w) > 0.99999f) {
    float sgn = w > 0 ? 1.0f : -1.0f;
    u = sint * cp;
    v = sint * sp;
    w = sgn * cost;
    return;
  }
  float tmp = sqrtf(1.0f - w * w);
  float nu = u * cost + sint * (u * w * cp - v * sp) / tmp;
  float nv = v * cost + sint * (v * w * cp + u * sp) / tmp;
  float nw = w * cost - sint * cp * tmp;
  float n = rsqrtf(nu * nu + nv * nv + nw * nw);
  u = nu * n;
  v = nv * n;
  w = nw * n;
}

// 射線跟網格的盒子：在盒子外就移到進入點；不會進來 → false
__device__ bool enter_grid(const Geo &g, P &p) {
  if (voxel(g, p.x, p.y, p.z) >= 0) return true;
  float lo[3] = {g.ox, g.oy, g.oz};
  float hi[3] = {g.ox + g.nx * g.dx, g.oy + g.ny * g.dy, g.oz + g.nz * g.dz};
  float o[3] = {p.x, p.y, p.z}, d[3] = {p.u, p.v, p.w};
  float t0 = 0.0f, t1 = 1e30f;
  for (int a = 0; a < 3; a++) {
    if (fabsf(d[a]) < 1e-12f) {
      if (o[a] < lo[a] || o[a] > hi[a]) return false;
      continue;
    }
    float ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
    if (ta > tb) { float t = ta; ta = tb; tb = t; }
    t0 = fmaxf(t0, ta);
    t1 = fminf(t1, tb);
  }
  if (t0 > t1) return false;
  t0 += 1e-4f;
  p.x += p.u * t0;
  p.y += p.v * t0;
  p.z += p.w * t0;
  return voxel(g, p.x, p.y, p.z) >= 0;
}

__device__ void push(P *stack, int &n, const P &p, unsigned long long *edep, const Geo &g, float escale, unsigned int *lost) {
  if (n < STACK) {
    stack[n++] = p;
  } else {  // 堆疊滿：能量就地沉積（計數，正常不會發生）
    deposit(edep, voxel(g, p.x, p.y, p.z), p.e + (p.type == T_POSITRON ? 2.0f * ME : 0.0f), escale);
    atomicAdd(lost, 1u);
  }
}

__device__ void photon(P p, P *stack, int &n, Rng &r, const Geo &g, const Tab &tb, const unsigned char *mat, const float *rho,
                       unsigned long long *edep, float escale, float pcut, unsigned int *lost) {
  if (!enter_grid(g, p)) return;
  for (int guard = 0; guard < 100000; guard++) {
    if (p.e < pcut) {
      deposit(edep, voxel(g, p.x, p.y, p.z), p.e, escale);
      return;
    }
    float mumax = lerp_mumax(tb, p.e);
    float s = -logf(rnd(r)) / mumax;
    p.x += p.u * s;
    p.y += p.v * s;
    p.z += p.w * s;
    int vx = voxel(g, p.x, p.y, p.z);
    if (vx < 0) return;
    int m = mat[vx];
    float scale = rho[vx] / tb.rho_ref[m];
    float sp = lerp_tab(tb, Q_PHOT, m, p.e) * scale;
    float sc = lerp_tab(tb, Q_COMPT, m, p.e) * scale;
    float sr = (p.e > 2.0f * ME ? lerp_tab(tb, Q_CONV, m, p.e) : 0.0f) * scale;
    float xi = rnd(r) * mumax;
    if (xi >= sp + sc + sr) continue;  // 虛擬碰撞
    if (xi < sp) {  // 光電：能量全給電子（方向沿光子；結合能就地）
      P e = {p.x, p.y, p.z, p.u, p.v, p.w, p.e, T_ELECTRON};
      push(stack, n, e, edep, g, escale, lost);
      return;
    }
    if (xi < sp + sc) {  // 康普頓：Klein–Nishina（Geant4 G4KleinNishinaCompton 的抽樣法）
      float k = p.e / ME;
      float eps0 = 1.0f / (1.0f + 2.0f * k), eps0sq = eps0 * eps0;
      float a1 = -logf(eps0), a2 = a1 + 0.5f * (1.0f - eps0sq);
      float eps, epssq, onecost, sint2, grej;
      do {
        if (a1 > a2 * rnd(r)) {
          eps = expf(-a1 * rnd(r));
          epssq = eps * eps;
        } else {
          epssq = eps0sq + (1.0f - eps0sq) * rnd(r);
          eps = sqrtf(epssq);
        }
        onecost = (1.0f - eps) / (eps * k);
        sint2 = onecost * (2.0f - onecost);
        grej = 1.0f - eps * sint2 / (1.0f + epssq);
      } while (grej < rnd(r));
      float e1 = eps * p.e, cost = 1.0f - onecost, phi = 6.28318531f * rnd(r);
      float px = p.e * p.u, py = p.e * p.v, pz = p.e * p.w;  // 光子動量（MeV/c）
      float u = p.u, v = p.v, w = p.w;
      rotate(u, v, w, fminf(1.0f, fmaxf(-1.0f, cost)), phi);
      float te = p.e - e1;
      float qx = px - e1 * u, qy = py - e1 * v, qz = pz - e1 * w, qn = sqrtf(qx * qx + qy * qy + qz * qz);
      if (te > 0.0f && qn > 0.0f) {
        P e = {p.x, p.y, p.z, qx / qn, qy / qn, qz / qn, te, T_ELECTRON};
        push(stack, n, e, edep, g, escale, lost);
      }
      p.e = e1;
      p.u = u;
      p.v = v;
      p.w = w;
      continue;
    }
    // 成對：動能 E − 2mc² 由電子與正子分，比例均勻；方向沿光子
    float t = p.e - 2.0f * ME, f = rnd(r);
    P e = {p.x, p.y, p.z, p.u, p.v, p.w, t * f, T_ELECTRON};
    P q = {p.x, p.y, p.z, p.u, p.v, p.w, t * (1.0f - f), T_POSITRON};
    push(stack, n, e, edep, g, escale, lost);
    push(stack, n, q, edep, g, escale, lost);
    return;
  }
}

// Wentzel 分佈的屏蔽參數 A：〈1 − cos θ〉＝ 2A[(1+A) ln(1+1/A) − 1] ＝ g1
__device__ float wentzel_a(float g1) {
  g1 = fminf(fmaxf(g1, 1e-7f), 0.999f);
  float a = g1 / (2.0f * fmaxf(logf(2.0f / g1), 1.0f));
  for (int it = 0; it < 12; it++) {
    float l = logf(1.0f + 1.0f / a);
    float f = 2.0f * a * ((1.0f + a) * l - 1.0f) - g1;
    float df = 2.0f * ((1.0f + 2.0f * a) * l - 2.0f);
    float na = a - f / df;
    a = na > 0.0f ? na : 0.5f * a;
  }
  return a;
}

__device__ void charged(P p, P *stack, int &n, Rng &r, const Geo &g, const Tab &tb, const unsigned char *mat, const float *rho,
                        unsigned long long *edep, float escale, float ecut, float tcut, float kcut, float smax_geo,
                        float frac_e, unsigned int *lost) {
  const bool pos = p.type == T_POSITRON;
  const int qs = pos ? Q_SP : Q_SE, qh = pos ? Q_BHABHA : Q_MOLLER, qb = pos ? Q_BREM_P : Q_BREM_E,
            qt = pos ? Q_TRS_P : Q_TRS_E, qe = pos ? Q_EH_P : Q_EH_E, qa = pos ? Q_A_P : Q_A_E,
            qx = pos ? Q_XC_P : Q_XC_E;
  int vx = voxel(g, p.x, p.y, p.z);
  for (int guard = 0; guard < 100000 && vx >= 0; guard++) {
    if (p.e <= ecut) break;
    int m = mat[vx];
    float scale = rho[vx] / tb.rho_ref[m];
    float S = lerp_tab(tb, qs, m, p.e) * scale;
    float sh = (lerp_tab(tb, qh, m, p.e) + lerp_tab(tb, qb, m, p.e) + lerp_tab(tb, qe, m, p.e)) * scale;
    float s_hard = sh > 0.0f ? -logf(rnd(r)) / sh : 1e30f;
    float s = fminf(fminf(s_hard, smax_geo), frac_e * p.e / fmaxf(S, 1e-12f));
    // 步伐停在體素邊界（＋一點點跨過去）：整步用起點體素的材質，跨過密度交界會錯
    float s_bnd = to_boundary(g, p.x, p.y, p.z, p.u, p.v, p.w) + 1e-4f;
    if (s_bnd < s) s = s_bnd;
    bool hard = s == s_hard;
    // 中點的阻擋本領
    float de = S * s;
    float tm = fmaxf(p.e - 0.5f * de, 0.5f * p.e);
    float S2 = lerp_tab(tb, qs, m, tm) * scale;
    de = S2 * s;
    // 能量損失漲落：受限碰撞的 Bohr 變異數，抽平均與變異數對齊的 Gamma 分佈（不會是負的）
    {
      float g2 = (tm + ME) / ME, b2 = 1.0f - 1.0f / (g2 * g2);
      float tc = fminf(tcut, tm);
      float var = lerp_tab(tb, Q_BOHR, m, tm) * scale * s * tc * (1.0f - 0.5f * b2) / b2;
      if (var > 0.0f && de > 0.0f) {
        float k = de * de / var;
        de = k > 400.0f ? fmaxf(0.0f, de + sqrtf(var) * gauss(r)) : gamma_k(r, k) * (var / de);
      }
    }
    de = fminf(de, p.e);
    float inv_l1 = lerp_tab(tb, qt, m, tm) * scale;
    // random hinge：走 τ、偏轉、走完剩下的；連續損失沉積在轉折點
    float tau = s * rnd(r);
    p.x += p.u * tau;
    p.y += p.v * tau;
    p.z += p.w * tau;
    int vh = voxel(g, p.x, p.y, p.z);
    if (vh < 0) return;  // 離開網格
    deposit(edep, vh, de, escale);
    float a = wentzel_a(1.0f - expf(-s * inv_l1));
    float xi = rnd(r);
    float cost = 1.0f - 2.0f * a * xi / (1.0f - xi + a);
    rotate(p.u, p.v, p.w, fminf(1.0f, fmaxf(-1.0f, cost)), 6.28318531f * rnd(r));
    p.x += p.u * (s - tau);
    p.y += p.v * (s - tau);
    p.z += p.w * (s - tau);
    p.e -= de;
    vx = voxel(g, p.x, p.y, p.z);
    if (vx < 0) return;
    if (!hard || p.e <= ecut) continue;
    // 離散事件：大角度彈性碰撞、Møller（δ 射線）或制動輻射，依此刻的截面比
    m = mat[vx];
    float sm = lerp_tab(tb, qh, m, p.e), sb = lerp_tab(tb, qb, m, p.e), sel = lerp_tab(tb, qe, m, p.e);
    float pick = rnd(r) * (sm + sb + sel);
    if (pick < sel) {
      // Wentzel 分佈在 x ＝ 1 − cos θ ≥ x_c 的那一段（反函數抽樣）
      float a = lerp_tab(tb, qa, m, p.e), xc = lerp_tab(tb, qx, m, p.e);
      float fc = (1.0f + a) * (1.0f - 2.0f * a / (xc + 2.0f * a));
      float u = fc + (1.0f - fc) * rnd(r);
      float x = 2.0f * a * u / (1.0f + a - u);
      // Mott 修正（McKinley–Feshbach）：接受率 R(x)／R_max；不接受 ＝ 這次沒有碰撞
      float beta = sqrtf(p.e * (p.e + 2.0f * ME)) / (p.e + ME);
      float z = lerp_tab(tb, Q_ZEFF, m, p.e), sn = sqrtf(fminf(fmaxf(0.5f * x, 0.0f), 1.0f));
      float sgn = pos ? -1.0f : 1.0f;
      float rm = 1.0f - beta * beta * sn * sn + sgn * 3.14159265f * z * beta * sn * (1.0f - sn) / 137.036f;
      float rmax = 1.0f + 3.14159265f * z * beta / (4.0f * 137.036f);
      if (rnd(r) * rmax < rm) rotate(p.u, p.v, p.w, fminf(1.0f, fmaxf(-1.0f, 1.0f - x)), 6.28318531f * rnd(r));
      continue;
    }
    if (pick < sel + sm) {
      if (p.e <= 2.0f * tcut) continue;
      // Møller（Geant4 G4MollerBhabhaModel 的抽樣）
      float gam = p.e / ME + 1.0f, gam2 = gam * gam;
      float xmin = tcut / p.e, xmax = 0.5f;
      float gg = (2.0f * gam - 1.0f) / gam2;
      float y = 1.0f - xmax;
      float grej = 1.0f - gg * xmax + xmax * xmax * (1.0f - gg + (1.0f - gg * y) / (y * y));
      float x, z;
      do {
        float q = rnd(r);
        x = xmin * xmax / (xmin * (1.0f - q) + xmax * q);
        y = 1.0f - x;
        z = 1.0f - gg * x + x * x * (1.0f - gg + (1.0f - gg * y) / (y * y));
      } while (grej * rnd(r) > z);
      float td = x * p.e;
      float cd = sqrtf(td * (p.e + 2.0f * ME) / (p.e * (td + 2.0f * ME)));
      float phi = 6.28318531f * rnd(r);
      float du = p.u, dv = p.v, dw = p.w;
      rotate(du, dv, dw, fminf(1.0f, cd), phi);
      // 原粒子方向：動量守恆
      float pt = sqrtf(p.e * (p.e + 2.0f * ME)), pd = sqrtf(td * (td + 2.0f * ME));
      float qx = pt * p.u - pd * du, qy = pt * p.v - pd * dv, qz = pt * p.w - pd * dw;
      float qn = sqrtf(qx * qx + qy * qy + qz * qz);
      P d = {p.x, p.y, p.z, du, dv, dw, td, T_ELECTRON};
      push(stack, n, d, edep, g, escale, lost);
      p.e -= td;
      if (qn > 0.0f) {
        p.u = qx / qn;
        p.v = qy / qn;
        p.w = qz / qn;
      }
    } else {
      // 制動輻射：k 在 [kcut, T] 依 1/k 抽；方向沿電子（近似）
      if (p.e <= kcut) continue;
      float k = kcut * expf(rnd(r) * logf(p.e / kcut));
      P ph = {p.x, p.y, p.z, p.u, p.v, p.w, k, T_PHOTON};
      push(stack, n, ph, edep, g, escale, lost);
      p.e -= k;
    }
  }
  if (vx >= 0) {
    deposit(edep, vx, p.e, escale);
    if (pos) {  // 停下來互毀：兩個 0.511 MeV 光子
      float cost = 2.0f * rnd(r) - 1.0f, phi = 6.28318531f * rnd(r), sint = sqrtf(1.0f - cost * cost);
      float u = sint * cosf(phi), v = sint * sinf(phi), w = cost;
      P a = {p.x, p.y, p.z, u, v, w, ME, T_PHOTON};
      P b = {p.x, p.y, p.z, -u, -v, -w, ME, T_PHOTON};
      push(stack, n, a, edep, g, escale, lost);
      push(stack, n, b, edep, g, escale, lost);
    }
  }
}

// 射源（驗證用的簡單射源；臨床射束模型之後接）：
//   kind 0：平行光束，起點在平面 o ＋ a·ex ＋ b·ey（a ∈ [−hx, hx]、b ∈ [−hy, hy]），方向 dir
//   kind 1：點射源 o，往等中心平面（距離 sad、沿 dir）上的矩形 [−hx, hx] × [−hy, hy]（ex、ey 方向）均勻發射
// particle：0 光子、1 電子、2 正子（驗證用；臨床射束只有光子）
// 能量：離散能譜的累積分佈 cdf（ne 個能階）
extern "C" __global__ void run(unsigned long long *edep, unsigned int *lost, const unsigned char *mat, const float *rho,
                               int nx, int ny, int nz, float dx, float dy, float dz, float ox, float oy, float oz,
                               const float *tab, const float *mumax, const float *rho_ref, int nmat, int ne,
                               float lne0, float dlne, int kind, float o_x, float o_y, float o_z, float d_x, float d_y,
                               float d_z, float ex_x, float ex_y, float ex_z, float ey_x, float ey_y, float ey_z, float sad,
                               float hx, float hy, int particle, const float *spec_e, const float *spec_cdf, int nspec,
                               unsigned long long seed, unsigned long long h0, int nhist, float escale, float pcut,
                               float ecut, float tcut, float kcut, float smax_geo, float frac_e) {
  Tab tb = {tab, mumax, rho_ref, nmat, ne, lne0, dlne};
  Geo g = {nx, ny, nz, dx, dy, dz, ox, oy, oz};
  float3 o = make_float3(o_x, o_y, o_z), dir = make_float3(d_x, d_y, d_z);
  float3 ex = make_float3(ex_x, ex_y, ex_z), ey = make_float3(ey_x, ey_y, ey_z);
  P stack[STACK];
  for (int idx = blockIdx.x * blockDim.x + threadIdx.x; idx < nhist; idx += gridDim.x * blockDim.x) {
    unsigned long long h = h0 + (unsigned long long)idx;
    unsigned long long sm = seed ^ (h * 0xD1B54A32D192ED03ULL);
    Rng r;
    r.s0 = splitmix(sm);
    r.s1 = splitmix(sm);
    // 能量
    float xi = rnd(r);
    int lo = 0, hi = nspec - 1;
    while (lo < hi) {
      int mid = (lo + hi) / 2;
      if (spec_cdf[mid] < xi) lo = mid + 1; else hi = mid;
    }
    P p;
    p.e = spec_e[lo];
    p.type = particle;
    float a = (2.0f * rnd(r) - 1.0f) * hx, b = (2.0f * rnd(r) - 1.0f) * hy;
    if (kind == 0) {
      p.x = o.x + a * ex.x + b * ey.x;
      p.y = o.y + a * ex.y + b * ey.y;
      p.z = o.z + a * ex.z + b * ey.z;
      p.u = dir.x;
      p.v = dir.y;
      p.w = dir.z;
    } else {
      p.x = o.x;
      p.y = o.y;
      p.z = o.z;
      float tx = sad * dir.x + a * ex.x + b * ey.x, ty = sad * dir.y + a * ex.y + b * ey.y, tz = sad * dir.z + a * ex.z + b * ey.z;
      float nn = rsqrtf(tx * tx + ty * ty + tz * tz);
      p.u = tx * nn;
      p.v = ty * nn;
      p.w = tz * nn;
    }
    int n = 0;
    if (p.type != T_PHOTON && !enter_grid(g, p)) continue;  // 帶電粒子射源：直接放到網格表面
    stack[n++] = p;
    while (n > 0) {
      P q = stack[--n];
      if (q.type == T_PHOTON)
        photon(q, stack, n, r, g, tb, mat, rho, edep, escale, pcut, lost);
      else
        charged(q, stack, n, r, g, tb, mat, rho, edep, escale, ecut, tcut, kcut, smax_geo, frac_e, lost);
    }
  }
}
