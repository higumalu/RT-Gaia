/**
 * 把 record.mjs 錄的各幕接成 demo 影片：片頭 → 各幕（燒英文字幕、淡入淡出）→ 片尾；另外切短片。
 *
 *   node scripts/demo/render.mjs                       # 全部幕 → media/rt-gaia-demo.mp4 ＋ media/clips/<幕>.mp4
 *   node scripts/demo/render.mjs --scenes library,viewer --out-name test.mp4
 *   node scripts/demo/render.mjs --readme docs/assets/demo     # 另出 README 用的完整影片（較小）與精華預覽 GIF
 *
 * 需要 ffmpeg（libx264、libass）與 Noto Sans 字型。字幕、片頭片尾的文字都在這支（英文）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCENES } from './scenes.mjs';
import { CREDITS } from './credits.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const OUT = resolve(args.out ?? '.rtgaia/demo/media');
const RAW = join(OUT, 'raw');
const TMP = join(OUT, 'tmp');
const CLIPS = join(OUT, 'clips');
mkdirSync(TMP, { recursive: true });
mkdirSync(CLIPS, { recursive: true });
const LOGO = resolve('assets/branding/rt-gaia-icon.png');
const W = 1920;
const H = 1080;
const FPS = 30;
const FONT = 'Noto Sans';
const ENCODE = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a.map(String)], { stdio: ['ignore', 'inherit', 'inherit'] });
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

// ── ASS 字幕 ────────────────────────────────────────────────────────────────
const ts = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const escapeAss = (text) => text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
function assFile(file, events) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // 字幕：底部置中、半透明深色底框（BorderStyle 3 用 OutlineColour 當底框）
    `Style: Caption,${FONT},44,&H00FFFFFF,&H000000FF,&H30101418,&H00000000,1,0,0,0,100,100,0,0,3,16,0,2,120,120,96,1`,
    `Style: Title,${FONT},110,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Sub,${FONT},44,&H00DAD2C8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Small,${FONT},30,&H00B4A8A0,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    // 手機那一幕：字幕放在手機左邊（中間靠左，寬到 x＝700）
    `Style: Side,${FONT},46,&H00FFFFFF,&H000000FF,&H30101418,&H00000000,1,0,0,0,100,100,0,0,3,16,0,4,120,${W - 700},0,1`,
    // 加速段的標記（右上角）
    `Style: Badge,${FONT},30,&H00FFFFFF,&H000000FF,&H60101418,&H00000000,1,0,0,0,100,100,0,0,3,10,0,9,0,460,215,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = events.map((e) => `Dialogue: 0,${ts(e.start)},${ts(e.end)},${e.style ?? 'Caption'},,0,0,0,,${e.tags ?? '{\\fad(180,180)}'}${escapeAss(e.text)}`);
  writeFileSync(file, [...head, ...lines, ''].join('\n'));
}

// ── 片頭、片尾 ──────────────────────────────────────────────────────────────
function card(name, seconds, events, { logo = true } = {}) {
  const ass = join(TMP, `${name}.ass`);
  assFile(ass, events);
  const out = join(TMP, `${name}.mp4`);
  const fade = `fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.6}:d=0.6`;
  if (logo) {
    ff('-f', 'lavfi', '-i', `color=c=0x14171c:s=${W}x${H}:r=${FPS}:d=${seconds}`, '-loop', '1', '-t', seconds, '-i', LOGO,
      '-filter_complex', `[1]scale=200:200[l];[0][l]overlay=(W-w)/2:250,ass=${ass},${fade}[v]`, '-map', '[v]', ...ENCODE, '-t', seconds, out);
  } else {
    ff('-f', 'lavfi', '-i', `color=c=0x14171c:s=${W}x${H}:r=${FPS}:d=${seconds}`, '-vf', `ass=${ass},${fade}`, ...ENCODE, '-t', seconds, out);
  }
  return out;
}

const title = () =>
  card('title', 4, [
    { start: 0.2, end: 4, style: 'Title', text: 'RT-Gaia', tags: '{\\pos(960,560)\\fad(400,300)}' },
    { start: 0.5, end: 4, style: 'Sub', text: 'Web-based radiotherapy imaging, contouring and review', tags: '{\\pos(960,660)\\fad(400,300)}' },
    { start: 0.8, end: 4, style: 'Small', text: 'Research software — not a medical device', tags: '{\\pos(960,760)\\fad(400,300)}' },
  ]);

const ending = () =>
  card('ending', 9, [
    { start: 0.2, end: 9, style: 'Title', text: 'RT-Gaia', tags: '{\\pos(960,520)\\fad(400,300)}' },
    { start: 0.5, end: 9, style: 'Sub', text: 'Open source · MIT License', tags: '{\\pos(960,610)\\fad(400,300)}' },
    { start: 0.8, end: 9, style: 'Small', text: CREDITS.join('\n'), tags: '{\\pos(960,780)\\fad(400,300)}' },
    { start: 1.0, end: 9, style: 'Small', text: 'Research software — not a medical device', tags: '{\\pos(960,1000)\\fad(400,300)}' },
  ]);

// ── 各幕 ────────────────────────────────────────────────────────────────────
/** 加速段（`rec.mark('fast', …)`，例：等 AI 推論）播放倍數。 */
const SPEED = 6;
/** 整段播放倍數（錄的時候照人的速度操作；成片 1.2 倍，總長約 3 分鐘、短片多在 10–20 秒）。`--play 1` 照原速。 */
const PLAY = Number(args.play ?? 1.2);
const size = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);

/** 一幕的時間軸：字幕、加速段、錄影時間 → 成片時間（加速段壓縮，再整段 PLAY 倍）。 */
function timeline(id) {
  const raw = join(RAW, `${id}.mkv`);
  if (!existsSync(raw)) throw new Error(`沒有錄好的幕：${raw}（先跑 record.mjs --scenes ${id}）`);
  const all = JSON.parse(readFileSync(join(RAW, `${id}.cues.json`), 'utf8'));
  const cues = all.filter((c) => c.text);
  const begin = all.find((c) => c.mark === 'fast' && c.edge === 'begin')?.t;
  const end = all.find((c) => c.mark === 'fast' && c.edge === 'end')?.t;
  const fast = begin !== undefined && end !== undefined && end > begin;
  const map = (t) => (!fast || t <= begin ? t : t <= end ? begin + (t - begin) / SPEED : begin + (end - begin) / SPEED + (t - end)) / PLAY;
  const rawLen = duration(raw);
  return { raw, cues, begin, end, fast, map, rawLen, len: map(rawLen) };
}

function scene(id) {
  const { raw, cues, begin, end, fast, map, rawLen, len } = timeline(id);
  const [w, h] = size(raw);
  const phone = w < W; // 手機那一幕錄的是窄螢幕：放在畫面中間，字幕放旁邊
  const ass = join(TMP, `${id}.ass`);
  assFile(ass, [
    ...cues.map((c) => ({ start: map(c.start), end: Math.min(map(c.end ?? rawLen), len - 0.1), text: c.text, ...(phone ? { style: 'Side' } : {}) })),
    ...(fast ? [{ start: map(begin), end: map(end), style: 'Badge', text: `▶▶ sped up ×${SPEED}`, tags: '{\\fad(120,120)}' }] : []),
  ]);
  const steps = [];
  let label = '0:v';
  if (fast) {
    steps.push(
      `[0:v]trim=0:${begin},setpts=PTS-STARTPTS[s0]`,
      `[0:v]trim=${begin}:${end},setpts=(PTS-STARTPTS)/${SPEED}[s1]`,
      `[0:v]trim=${end},setpts=PTS-STARTPTS[s2]`,
      '[s0][s1][s2]concat=n=3:v=1[cat]',
    );
    label = 'cat';
  }
  if (PLAY !== 1) {
    steps.push(`[${label}]setpts=PTS/${PLAY}[play]`);
    label = 'play';
  }
  if (phone) {
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    steps.push(`[${label}]pad=${W}:${H}:${x}:${y}:color=0x14171c,drawbox=x=${x - 8}:y=${y - 8}:w=${w + 16}:h=${h + 16}:color=0x3a3f47:t=8[framed]`);
    label = 'framed';
  }
  steps.push(`[${label}]ass=${ass},fade=t=in:st=0:d=0.35,fade=t=out:st=${(len - 0.4).toFixed(2)}:d=0.4[v]`);
  const out = join(TMP, `${id}.mp4`);
  ff('-i', raw, '-filter_complex', steps.join(';'), '-map', '[v]', ...ENCODE, out);
  return out;
}

function concat(parts, out) {
  const list = join(TMP, 'concat.txt');
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out);
}

const ids = args.scenes ? args.scenes.split(',') : SCENES.map((x) => x.id);
const rendered = ids.map((id) => {
  console.log(`幕 ${id}`);
  const file = scene(id);
  ff('-i', file, '-c', 'copy', '-movflags', '+faststart', join(CLIPS, `${id}.mp4`));
  return file;
});
const final = join(OUT, args['out-name'] ?? 'rt-gaia-demo.mp4');
concat([title(), ...rendered, ending()], final);
console.log(`完成：${final}（${duration(final).toFixed(1)} s）；短片在 ${CLIPS}`);

// ── README 用（`--readme docs/assets/demo`）──────────────────────────────────
// GitHub 的 README 只會內嵌播放「網頁上傳的附件」，repo 裡的 mp4 用 <video> 不會顯示 → README 放會動的預覽（GIF），點了開完整影片。
/** 預覽的片段：[幕, 第幾段字幕, 從那段的 'start' 或 'end' 起算, 位移（成片秒）, 長度]。用字幕定位，重錄後不用重調。 */
const PREVIEW = [
  ['contour', 1, 'end', -3.6, 3.6], // 閾值筆刷畫下去
  ['dose', 2, 'start', 2.0, 3.0], // DVH 出現
  ['4d', 0, 'start', 0.2, 3.0], // 呼吸相位播放
  ['plan', 1, 'start', 0.2, 4.0], // BEV 控制點播放
  ['3d', 0, 'start', 0.5, 4.2], // 3D 旋轉
  ['plugin', 1, 'start', 0.1, 3.5], // AI 結果出現
];
if (args.readme) {
  const dir = resolve(args.readme);
  mkdirSync(dir, { recursive: true });
  // 完整影片：crf 27（介面小字跟 crf 20 看不出差別，檔案小一半）
  ff('-i', final, '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'rt-gaia-demo.mp4'));
  const inputs = [];
  const parts = [];
  PREVIEW.forEach(([id, n, edge, offset, len], i) => {
    const { cues, map } = timeline(id);
    const cue = cues[n];
    if (cue === undefined) throw new Error(`預覽：${id} 沒有第 ${n} 段字幕`);
    const at = Math.max(0, map(edge === 'start' ? cue.start : cue.end) + offset);
    inputs.push('-ss', at.toFixed(2), '-t', String(len), '-i', join(CLIPS, `${id}.mp4`));
    parts.push(`[${i}:v]fps=8,scale=800:-2:flags=lanczos,setsar=1[p${i}]`);
  });
  const cat = `${PREVIEW.map((_, i) => `[p${i}]`).join('')}concat=n=${PREVIEW.length}:v=1[c]`;
  // 128 色調色盤 ＋ 只重畫有變的方框（介面大多不動，GIF 小很多）
  const gif = '[c]split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[pal];[b][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  ff(...inputs, '-filter_complex', [...parts, cat, gif].join(';'), '-loop', '0', join(dir, 'demo-preview.gif'));
  // 手機那一幕另出一張：只裁手機（連外框），去掉頭尾淡入淡出
  const phone = timeline('phone');
  const [pw, ph] = size(phone.raw);
  const crop = `crop=${pw + 16}:${ph + 16}:${Math.round((W - pw) / 2) - 8}:${Math.round((H - ph) / 2) - 8}`;
  ff('-ss', '0.35', '-t', (phone.len - 0.8).toFixed(2), '-i', join(CLIPS, 'phone.mp4'), '-filter_complex', `[0:v]${crop},fps=10,scale=360:-2:flags=lanczos,setsar=1[c];${gif}`, '-loop', '0', join(dir, 'phone-preview.gif'));
  console.log(`README：${dir}/rt-gaia-demo.mp4、demo-preview.gif、phone-preview.gif`);
}
