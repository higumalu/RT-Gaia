/**
 * 多語系遷移工具：把指定檔案裡的中文字面值包進 `t()`／`msg()`，並補 import。
 *
 *   node scripts/i18n-wrap.ts src/react/auth/LoginPage.tsx [...]
 *
 * 規則：
 * * JSX 文字 `帳號` → `{t('帳號')}`；JSX 屬性 `title="說明"` → `title={t('說明')}`
 * * 一般字串 → `t('…')`；**模組最上層**（不在任何函式裡）→ `msg('…')`（載入時就翻會把語言定死；顯示處要自己 `t(x)`）
 * * 模板字串 `密碼至少 ${minLength} 個字元` → `t('密碼至少 {minLength} 個字元', { minLength })`（變數名當佔位符名）
 * * **跳過並回報**（要人看）：比較（`===`、`startsWith` 等）裡的字串、物件鍵、`case`、最上層的模板字串、只有標點的字串
 * 只改字面值，不動邏輯；跑完一律 tsc／eslint／vitest，再人工看一次回報的地方。英文譯文另外寫進 `src/core/i18n/en.ts`。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const I18N = resolve(import.meta.dirname, '../src/core/i18n');

interface Edit {
  start: number;
  end: number;
  text: string;
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

function inFunction(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassElement(p)) return true;
  }
  return false;
}

function isComparison(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ['startsWith', 'endsWith', 'includes', 'indexOf', 'localeCompare', 'split', 'replace'].includes(p.expression.name.text)) return true;
  if (ts.isCaseClause(p)) return true;
  return false;
}

function isMarkerArg(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && (p.expression.text === 't' || p.expression.text === 'msg');
}

function placeholderName(expr: ts.Expression, used: Set<string>, i: number): string {
  let base = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : `p${i}`;
  if (!/^\w+$/.test(base)) base = `p${i}`;
  let name = base;
  let k = 2;
  while (used.has(name)) name = `${base}${k++}`;
  used.add(name);
  return name;
}

function wrapFile(path: string): { edits: number; skipped: string[] } {
  const src = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const skipped: string[] = [];
  let usesT = false;
  let usesMsg = false;
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const skip = (n: ts.Node, why: string): void => {
    skipped.push(`${path}:${line(n)} ${why}：${n.getText(sf).slice(0, 70)}`);
  };

  /** 模板字串 → `t('…{name}…', { name: expr })`；參數運算式裡的中文也遞迴包起來。 */
  const convertTemplate = (node: ts.TemplateExpression): string => {
    const used = new Set<string>();
    let text = node.head.text;
    const params: string[] = [];
    node.templateSpans.forEach((span, i) => {
      const name = placeholderName(span.expression, used, i);
      text += `{${name}}${span.literal.text}`;
      const exprText = wrapInner(span.expression);
      params.push(exprText === name ? name : `${name}: ${exprText}`);
    });
    usesT = true;
    return `t(${quote(text)}, { ${params.join(', ')} })`;
  };
  /** 運算式文字裡的中文字面值也包起來（合併 JSX 句子時，運算式是原樣搬進參數的）。 */
  const wrapInner = (expr: ts.Expression): string => {
    const base = expr.getStart(sf);
    const inner: Edit[] = [];
    const walk = (n: ts.Node): void => {
      if (isMarkerArg(n)) return;
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK.test(n.text)) {
        if (/^[\s\p{P}\p{S}]+$/u.test(n.text)) return; // 標點：留給人（joinList 等）
        inner.push({ start: n.getStart(sf) - base, end: n.getEnd() - base, text: `t(${quote(n.text)})` });
        usesT = true;
        return;
      }
      if (ts.isTemplateExpression(n) && CJK.test(n.getText(sf))) {
        inner.push({ start: n.getStart(sf) - base, end: n.getEnd() - base, text: convertTemplate(n) });
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(expr);
    let text = expr.getText(sf);
    for (const e of inner.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
  };
  const hasJsx = (n: ts.Node): boolean => {
    let found = false;
    const walk = (c: ts.Node): void => {
      if (found) return;
      if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c)) found = true;
      else ts.forEachChild(c, walk);
    };
    walk(n);
    return found;
  };
  /** JSX 文字的空白規則（近似 React）：每行去頭尾空白、丟空行、以空格接；單行保留原本的頭尾空格。 */
  const decodeEntities = (v: string): string => v.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
  const jsxTextValue = (raw: string): string => decodeEntities(jsxTextValueRaw(raw));
  const jsxTextValueRaw = (raw: string): string => {
    if (!raw.includes('\n')) return raw.replace(/\s+/g, ' ');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.join(' ');
  };
  /**
   * 一串 JSX 子節點「文字 {運算式} 文字」合成一句 `t('…{p0}…', { p0: … })` —— 拆成片段（`t('（你是')`…`t('）')`）翻不了。
   * 運算式裡有 JSX 就不合併（那是版面，不是句子）。
   */
  const mergeJsxRuns = (children: ts.NodeArray<ts.JsxChild>): Set<ts.Node> => {
    const merged = new Set<ts.Node>();
    let run: ts.JsxChild[] = [];
    const flush = (): void => {
      // 去掉頭尾的純空白文字
      while (run.length > 0 && ts.isJsxText(run[0]!) && run[0]!.text.trim() === '') run.shift();
      while (run.length > 0 && ts.isJsxText(run[run.length - 1]!) && run[run.length - 1]!.text.trim() === '') run.pop();
      const texts = run.filter((c): c is ts.JsxText => ts.isJsxText(c));
      const exprs = run.filter((c): c is ts.JsxExpression => ts.isJsxExpression(c));
      if (exprs.length > 0 && texts.some((x) => CJK.test(x.text))) {
        const used = new Set<string>();
        let text = '';
        const params: string[] = [];
        run.forEach((c, i) => {
          if (ts.isJsxText(c)) {
            let v = jsxTextValue(c.getFullText(sf));
            if (i === 0) v = v.trimStart();
            if (i === run.length - 1) v = v.trimEnd();
            text += v;
          } else if (ts.isJsxExpression(c) && c.expression) {
            const name = placeholderName(c.expression, used, params.length);
            text += `{${name}}`;
            const exprText = wrapInner(c.expression);
            params.push(exprText === name ? name : `${name}: ${exprText}`);
          }
        });
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const start = ts.isJsxText(first) ? first.getFullStart() + (first.getFullText(sf).length - first.getFullText(sf).trimStart().length) : first.getStart(sf);
        const end = ts.isJsxText(last) ? last.getEnd() - (last.getFullText(sf).length - last.getFullText(sf).trimEnd().length) : last.getEnd();
        edits.push({ start, end, text: `{t(${quote(text)}, { ${params.join(', ')} })}` });
        usesT = true;
        for (const c of run) merged.add(c);
      }
      run = [];
    };
    for (const c of children) {
      if (ts.isJsxText(c)) run.push(c);
      else if (ts.isJsxExpression(c) && c.expression && !hasJsx(c.expression) && !(ts.isBinaryExpression(c.expression) && c.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) run.push(c);
      else flush();
    }
    flush();
    return merged;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const merged = mergeJsxRuns(node.children);
      if (ts.isJsxElement(node)) ts.forEachChild(node.openingElement, visit);
      for (const c of node.children) if (!merged.has(c)) visit(c);
      return;
    }
    if (ts.isJsxText(node) && CJK.test(node.text)) {
      const raw = node.getFullText(sf);
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      const inner = decodeEntities(raw.trim().replace(/\s+/g, ' '));
      const start = node.getFullStart() + lead;
      edits.push({ start, end: node.getEnd() - trail, text: `{t(${quote(inner)})}` });
      usesT = true;
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK.test(node.text) && !isMarkerArg(node)) {
      const p = node.parent;
      if (isComparison(node)) return skip(node, '比較');
      if (/^[\s\p{P}\p{S}]+$/u.test(node.text)) return skip(node, '只有標點（連接用 joinClauses／joinList）');
      if (p && (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === node) return skip(node, '物件鍵');
      if (p && ts.isJsxAttribute(p)) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `{t(${quote(node.text)})}` });
        usesT = true;
        return;
      }
      if (!inFunction(node)) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `msg(${quote(node.text)})` });
        usesMsg = true;
        return;
      }
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `t(${quote(node.text)})` });
      usesT = true;
      return;
    }
    if (ts.isTemplateExpression(node) && CJK.test(node.getText(sf)) && !isMarkerArg(node)) {
      if (!inFunction(node)) return skip(node, '最上層模板字串');
      if (isComparison(node)) return skip(node, '比較');
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text: convertTemplate(node) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (edits.length === 0) return { edits: 0, skipped };
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // import
  const names = [usesMsg ? 'msg' : null, usesT ? 't' : null].filter(Boolean) as string[];
  let rel = relative(dirname(resolve(path)), I18N).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const existing = new RegExp(`import \\{([^}]*)\\} from '${rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';`);
  const m = out.match(existing);
  if (m) {
    const have = new Set(m[1]!.split(',').map((x) => x.trim()).filter(Boolean));
    for (const n of names) have.add(n);
    out = out.replace(existing, `import { ${[...have].sort((a, b) => a.localeCompare(b)).join(', ')} } from '${rel}';`);
  } else {
    const lastImport = [...out.matchAll(/^import [^;]+;$/gm)].pop();
    const stmt = `import { ${names.join(', ')} } from '${rel}';`;
    if (lastImport && lastImport.index !== undefined) {
      const at = lastImport.index + lastImport[0].length;
      out = `${out.slice(0, at)}\n${stmt}${out.slice(at)}`;
    } else {
      // 沒有 import：放在檔頭註解之後
      const header = out.match(/^\/\*\*[\s\S]*?\*\/\n/);
      out = header ? `${header[0]}\n${stmt}\n${out.slice(header[0].length)}` : `${stmt}\n${out}`;
    }
  }
  writeFileSync(path, out);
  return { edits: edits.length, skipped };
}

let total = 0;
const allSkipped: string[] = [];
for (const f of process.argv.slice(2)) {
  const r = wrapFile(f);
  total += r.edits;
  allSkipped.push(...r.skipped);
  console.log(`${f}: ${r.edits} 處`);
}
console.log(`共 ${total} 處`);
if (allSkipped.length > 0) {
  console.log('\n要人工看：');
  for (const s of allSkipped) console.log(`  ${s}`);
}
