/**
 * 錄 demo 影片的各幕（英文介面、只用 data/demo 的 CC BY 公開資料）。每一幕各錄一個檔，方便單獨重錄：
 *
 *   scripts/demo/stack.sh start
 *   node scripts/demo/record.mjs                         # 全部幕，依序
 *   node scripts/demo/record.mjs --scenes library,viewer  # 只錄這幾幕
 *   node scripts/demo/record.mjs --scenes contour --dry 1  # 只跑 setup 並截圖（量位置用）
 *   node scripts/demo/render.mjs                         # 接起來、燒字幕、切短片
 *
 * 輸出在 .rtgaia/demo/media/raw/<幕>.mkv ＋ <幕>.cues.json（字幕時間點，相對該幕開頭）。
 * 每一幕的 setup 把畫面準備好（不錄），run 才錄；字幕用 rec.cue('…') 標。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openScreen, login, sleep } from './lib/screen.mjs';
import { SCENES } from './scenes.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const FE = process.env.DEMO_FE ?? 'http://127.0.0.1:5186';
const BE = process.env.DEMO_BE ?? 'http://127.0.0.1:8096';
const OUT = args.out ?? join(process.cwd(), '.rtgaia/demo/media');
const RAW = join(OUT, 'raw');
mkdirSync(RAW, { recursive: true });

const wanted = args.scenes ? args.scenes.split(',') : SCENES.map((s) => s.id);
const unknown = wanted.filter((id) => !SCENES.some((s) => s.id === id));
if (unknown.length) throw new Error(`不認識的幕：${unknown.join(', ')}（有：${SCENES.map((s) => s.id).join(', ')}）`);

const token = await login(BE, process.env.DEMO_USER ?? 'physicist', process.env.DEMO_PASSWORD ?? 'demo-password-2026');
// WebGL 走 ANGLE＋Vulkan 用實體 GPU：Xvfb 底下 Chrome 預設沒有 WebGL2，檢視器會判成沒有 GPU（3D 格改成伺服器靜態圖）
const GPU_ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--ignore-gpu-blocklist'];
const s = await openScreen({ url: `${FE}/#/library`, token, chromeArgs: process.env.DEMO_NO_GPU ? [] : GPU_ARGS });
const ctx = { FE, BE, login: (u) => login(BE, u, process.env.DEMO_PASSWORD ?? 'demo-password-2026') };
// 有 `screen` 的幕（手機）用另一個螢幕：另一個 Xvfb display、另一個 Chrome、裝置模擬；第一次用到才開
const screens = new Map();
async function screenFor(scene) {
  if (!scene.screen) return s;
  const key = JSON.stringify(scene.screen);
  if (!screens.has(key)) {
    const who = await login(BE, scene.screen.user ?? 'physicist', process.env.DEMO_PASSWORD ?? 'demo-password-2026');
    screens.set(key, await openScreen({ url: `${FE}/#/library`, token: who, chromeArgs: GPU_ARGS, display: ':98', port: 9378, ...scene.screen }));
  }
  return screens.get(key);
}
try {
  for (const scene of SCENES.filter((x) => wanted.includes(x.id))) {
    console.log(`── ${scene.id}：setup`);
    const sc = await screenFor(scene);
    await scene.setup?.(sc, ctx);
    await sleep(800);
    if (args.dry) {
      // 只跑 setup、截圖（量位置用），不錄
      sc.grab(join(RAW, `${scene.id}-setup.png`));
      console.log(`   dry：${join(RAW, `${scene.id}-setup.png`)}`);
      continue;
    }
    console.log(`── ${scene.id}：錄影`);
    // mkv：中途出錯沒收尾也讀得到（mp4 少了 moov 就整個打不開）
    const rec = sc.record(join(RAW, `${scene.id}.mkv`));
    await sleep(400);
    try {
      await scene.run(sc, rec, ctx);
    } catch (err) {
      await rec.stop(join(RAW, `${scene.id}.cues.json`));
      sc.grab(join(RAW, `${scene.id}-failed.png`));
      throw err;
    }
    await sleep(600);
    const cues = await rec.stop(join(RAW, `${scene.id}.cues.json`));
    console.log(`   ${cues.filter((c) => c.text).length} 段字幕、${rec.now().toFixed(1)} s`);
  }
} finally {
  if (s.errors.length) console.error('頁面錯誤：', s.errors.slice(0, 5));
  for (const x of [s, ...screens.values()]) if (x.dialogs.length) console.error('出現過原生對話框（已自動按確定，成片要檢查）：', x.dialogs);
  for (const x of screens.values()) x.close();
  s.close();
}
process.exit(0);
