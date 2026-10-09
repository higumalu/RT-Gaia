/**
 * 多語系防退步掃描：用 TypeScript AST 找 `src/` 裡的中文字面值。
 * * 在 `t()`／`msg()` 第一個參數的字面值 → 「已處理」（同時收集成原文清單，檢查英文字典有沒有譯文）。
 * * 其他地方的中文字串／模板字串／JSX 文字 → 「未處理」。註解不是節點，自然不算。
 * `tests/i18n.test.ts` 與 `scripts/i18n-report.mjs` 共用。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;

export interface Found {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface TranslatedSource {
  readonly file: string;
  readonly line: number;
  readonly source: string;
  readonly ctx: string | undefined;
}

export interface ScanResult {
  readonly untranslated: Found[];
  readonly sources: TranslatedSource[];
  /** `t()` 第一個參數不是字面值（模板、變數）—— 除了 `t(x.label)` 這種轉手的，都應該是字面值。 */
  readonly dynamic: Found[];
}

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const isMarker = (call: ts.CallExpression): 't' | 'msg' | null => {
  const e = call.expression;
  if (ts.isIdentifier(e) && (e.text === 't' || e.text === 'msg')) return e.text;
  return null;
};

export function scanFile(path: string, rel: string): ScanResult {
  const text = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const untranslated: Found[] = [];
  const sources: TranslatedSource[] = [];
  const dynamic: Found[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const handled = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const marker = isMarker(node);
      const first = node.arguments[0];
      // `ctx` 是 key 的一部分，不是介面文字（第一個參數是運算式時也一樣）
      const second = node.arguments[1];
      if (marker && second && ts.isObjectLiteralExpression(second)) {
        for (const prop of second.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'ctx') handled.add(prop.initializer);
        }
      }
      if (marker && first) {
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          handled.add(first);
          let ctx: string | undefined;
          const second = node.arguments[1];
          if (second && ts.isObjectLiteralExpression(second)) {
            for (const prop of second.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'ctx' && ts.isStringLiteral(prop.initializer)) {
                ctx = prop.initializer.text;
                handled.add(prop.initializer);
              }
            }
          }
          sources.push({ file: rel, line: lineOf(first), source: first.text, ctx });
        } else if (ts.isTemplateExpression(first) && CJK.test(first.getText(sf))) {
          dynamic.push({ file: rel, line: lineOf(first), text: first.getText(sf) });
          first.forEachChild((c) => handled.add(c));
          handled.add(first.head);
          for (const span of first.templateSpans) handled.add(span.literal);
        }
      }
    }
    const isStringy =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (isStringy && !handled.has(node)) {
      const raw = ts.isJsxText(node) ? node.text : (node as ts.LiteralLikeNode).text;
      if (CJK.test(raw)) {
        // import 路徑、型別裡的字面值型別不是介面文字
        const parent = node.parent;
        const inType = parent !== undefined && (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent));
        if (!inType) untranslated.push({ file: rel, line: lineOf(node), text: raw.trim().slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { untranslated, sources, dynamic };
}

export function scanTree(srcRoot: string, repoRoot: string): Map<string, ScanResult> {
  const out = new Map<string, ScanResult>();
  for (const p of listSourceFiles(srcRoot)) {
    const rel = relative(repoRoot, p).replace(/\\/g, '/');
    // 字典本身、語言名稱（「中文」在任何語言都顯示成「中文」）不算
    if (rel.includes('/core/i18n/')) continue;
    out.set(rel, scanFile(p, rel));
  }
  return out;
}
