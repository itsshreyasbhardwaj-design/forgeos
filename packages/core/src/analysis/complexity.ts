import { countLines, detectLanguage, type LanguageDefinition } from './languages.js';
import { clamp, round } from '../kernel/text.js';

/**
 * Complexity metrics computed without a full parser.
 *
 * A real AST per language would be more precise, but it would also mean
 * shipping a parser for every language ForgeOS supports. Instead we strip
 * comments and string literals — which removes essentially all the false
 * positives — and then count decision points on the remaining tokens. On
 * hand-checked samples this lands within ±1 of a proper cyclomatic count for
 * ordinary code, which is well inside the noise floor for a *ranking* signal.
 */

/** Tokens that introduce a branch, per language family. */
const DECISION_KEYWORDS: Record<string, readonly string[]> = {
  default: ['if', 'else if', 'elif', 'for', 'while', 'case', 'catch', 'and', 'or'],
  c: ['if', 'for', 'while', 'case', 'catch', 'goto'],
  python: ['if', 'elif', 'for', 'while', 'except', 'assert', 'with'],
  go: ['if', 'for', 'case', 'select'],
  ruby: ['if', 'elsif', 'unless', 'for', 'while', 'until', 'when', 'rescue'],
};

const OPERATORS: Record<string, readonly string[]> = {
  default: ['&&', '||', '??', '?'],
  python: [],
  ruby: [],
};

function keywordsFor(language: LanguageDefinition | undefined): readonly string[] {
  if (!language) return DECISION_KEYWORDS.default as readonly string[];
  switch (language.id) {
    case 'python':
      return DECISION_KEYWORDS.python as readonly string[];
    case 'go':
      return DECISION_KEYWORDS.go as readonly string[];
    case 'ruby':
      return DECISION_KEYWORDS.ruby as readonly string[];
    case 'c':
    case 'cpp':
    case 'java':
    case 'csharp':
      return DECISION_KEYWORDS.c as readonly string[];
    default:
      return DECISION_KEYWORDS.default as readonly string[];
  }
}

function operatorsFor(language: LanguageDefinition | undefined): readonly string[] {
  if (!language) return OPERATORS.default as readonly string[];
  if (language.id === 'python') return OPERATORS.python as readonly string[];
  if (language.id === 'ruby') return OPERATORS.ruby as readonly string[];
  return OPERATORS.default as readonly string[];
}

/**
 * Remove comments, and optionally the *contents* of string literals, while
 * preserving line structure so reported line numbers stay accurate.
 *
 * Two callers want two different things, and conflating them is a real bug:
 * complexity counting wants string contents gone (so a URL in a string cannot
 * look like a comment or an operator), whereas import extraction needs the
 * string contents intact (the specifier *is* the string). Hence the flag.
 */
function strip(
  text: string,
  language: LanguageDefinition | undefined,
  keepStringContents: boolean
): string {
  const lineComments = language?.lineComment ?? ['//', '#'];
  const blockComments = language?.blockComment ?? [['/*', '*/']];
  const quotes = language?.stringDelimiters ?? ['"', "'", '`'];

  let out = '';
  let index = 0;
  let openBlock: readonly [string, string] | null = null;
  let quote: string | null = null;

  while (index < text.length) {
    const char = text[index] as string;

    if (openBlock) {
      if (text.startsWith(openBlock[1], index)) {
        index += openBlock[1].length;
        openBlock = null;
      } else {
        if (char === '\n') out += '\n';
        index++;
      }
      continue;
    }

    if (quote) {
      if (char === '\\') {
        if (keepStringContents) out += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (text.startsWith(quote, index)) {
        out += quote;
        index += quote.length;
        quote = null;
        continue;
      }
      if (keepStringContents || char === '\n') out += char;
      index++;
      continue;
    }

    const block = blockComments.find(([open]) => text.startsWith(open, index));
    if (block) {
      openBlock = block;
      index += block[0].length;
      continue;
    }

    if (lineComments.some((marker) => text.startsWith(marker, index))) {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }

    const openQuote = quotes.find((q) => text.startsWith(q, index));
    if (openQuote) {
      out += openQuote;
      quote = openQuote;
      index += openQuote.length;
      continue;
    }

    out += char;
    index++;
  }

  return out;
}

/** Strip comments *and* string contents. For metrics and duplicate detection. */
export function stripNonCode(text: string, language?: LanguageDefinition): string {
  return strip(text, language, false);
}

/** Strip comments only, leaving string literals intact. For import extraction. */
export function stripComments(text: string, language?: LanguageDefinition): string {
  return strip(text, language, true);
}

function countKeywords(haystack: string, keywords: readonly string[]): number {
  let total = 0;
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, 'g'));
    total += matches ? matches.length : 0;
  }
  return total;
}

/**
 * Count operators in a single pass with longest-match-first alternation.
 *
 * Counting each operator with its own regex double-counts overlapping tokens:
 * `a ?? b` matches `??` once and `?` twice, inflating one operator into three
 * decision points. A single alternation consumes each token exactly once.
 */
function countOperators(haystack: string, operators: readonly string[]): number {
  if (operators.length === 0) return 0;
  const alternation = [...operators]
    .sort((a, b) => b.length - a.length)
    .map((operator) => operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const matches = haystack.match(new RegExp(alternation, 'g'));
  return matches ? matches.length : 0;
}

/** Cyclomatic complexity of a block of code (1 + number of decision points). */
export function cyclomaticComplexity(code: string, language?: LanguageDefinition): number {
  const stripped = stripNonCode(code, language);
  const keywords = countKeywords(stripped, keywordsFor(language));
  const operators = countOperators(stripped, operatorsFor(language));
  // `else if` was already counted by `if`; ternaries and `??` each add one path.
  return 1 + keywords + operators;
}

/** Maximum block nesting depth, a strong readability signal. */
export function maxNestingDepth(code: string, language?: LanguageDefinition): number {
  const stripped = stripNonCode(code, language);
  if (language?.id === 'python') {
    let max = 0;
    for (const line of stripped.split('\n')) {
      if (line.trim() === '') continue;
      const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
      max = Math.max(max, Math.floor(indent / 4));
    }
    return max;
  }
  let depth = 0;
  let max = 0;
  for (const char of stripped) {
    if (char === '{') max = Math.max(max, ++depth);
    else if (char === '}') depth = Math.max(0, depth - 1);
  }
  return max;
}

export interface FunctionUnit {
  readonly name: string;
  readonly line: number;
  readonly endLine: number;
  readonly lines: number;
  readonly complexity: number;
  readonly parameters: number;
}

const FUNCTION_PATTERNS: Record<string, RegExp> = {
  clike:
    /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>)|([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\{)/g,
  python: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm,
  go: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/gm,
  rust: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gm,
  ruby: /^[ \t]*def\s+([A-Za-z_][\w?!]*)/gm,
};

function patternFor(language: LanguageDefinition | undefined): RegExp | null {
  if (!language) return null;
  switch (language.id) {
    case 'python':
      return new RegExp(FUNCTION_PATTERNS.python!.source, 'gm');
    case 'go':
      return new RegExp(FUNCTION_PATTERNS.go!.source, 'gm');
    case 'rust':
      return new RegExp(FUNCTION_PATTERNS.rust!.source, 'gm');
    case 'ruby':
      return new RegExp(FUNCTION_PATTERNS.ruby!.source, 'gm');
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
    case 'java':
    case 'csharp':
    case 'cpp':
    case 'c':
    case 'swift':
    case 'kotlin':
    case 'php':
    case 'dart':
    case 'scala':
      return new RegExp(FUNCTION_PATTERNS.clike!.source, 'g');
    default:
      return null;
  }
}

/**
 * Read the parameter list that follows `from`, counting balanced parentheses.
 *
 * Reading this from the source is more reliable than adding another capture
 * group per function form: the group indices differ between the `function`,
 * arrow and method alternatives, and getting them out of step silently reports
 * every function as taking no parameters.
 */
function countParameters(code: string, from: number): number {
  const open = code.indexOf('(', from);
  if (open === -1) return 0;

  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return 0;

  const inner = code.slice(open + 1, end).trim();
  if (inner === '') return 0;

  // Split on top-level commas only; a default value or generic may contain them.
  let nesting = 0;
  let count = 1;
  for (const char of inner) {
    if ('([{<'.includes(char)) nesting++;
    else if (')]}>'.includes(char)) nesting--;
    else if (char === ',' && nesting === 0) count++;
  }
  return count;
}

/** Find the end of a brace-delimited body starting at or after `from`. */
function findBlockEnd(code: string, from: number): number {
  const open = code.indexOf('{', from);
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

/** Find the end of an indentation-delimited body (Python, Ruby-ish). */
function findIndentEnd(lines: readonly string[], startLine: number): number {
  const startIndent = (/^[ \t]*/.exec(lines[startLine] ?? '')?.[0] ?? '').length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').length;
    if (indent <= startIndent) return i - 1;
  }
  return lines.length - 1;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Extract per-function complexity.
 *
 * Returns an empty list for languages without a pattern rather than guessing —
 * a wrong function boundary produces a misleading hotspot, which is worse than
 * no hotspot at all.
 */
export function extractFunctions(text: string, language?: LanguageDefinition): FunctionUnit[] {
  const pattern = patternFor(language);
  if (!pattern) return [];

  const stripped = stripNonCode(text, language);
  const lines = stripped.split('\n');
  const units: FunctionUnit[] = [];
  const indentBased = language?.id === 'python' || language?.id === 'ruby';

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const name = match[1] ?? match[2] ?? match[3] ?? '(anonymous)';
    // Skip control-flow keywords that look like calls: `if (…) {`.
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(name)) continue;

    const startLine = lineOf(stripped, match.index);
    let endLine: number;
    let body: string;

    if (indentBased) {
      const endIndex = findIndentEnd(lines, startLine - 1);
      endLine = endIndex + 1;
      body = lines.slice(startLine - 1, endLine).join('\n');
    } else {
      const end = findBlockEnd(stripped, match.index);
      if (end === -1) continue;
      endLine = lineOf(stripped, end);
      body = stripped.slice(match.index, end + 1);
    }

    const parameters = countParameters(stripped, match.index);

    units.push({
      name,
      line: startLine,
      endLine,
      lines: Math.max(1, endLine - startLine + 1),
      complexity: cyclomaticComplexity(body, language),
      parameters,
    });
    if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
  }

  return units.sort((a, b) => a.line - b.line);
}

export interface FileComplexity {
  readonly path: string;
  readonly language: string | null;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
  readonly complexity: number;
  readonly nesting: number;
  /** 0–100, higher is better. Derived from the maintainability index. */
  readonly maintainability: number;
  readonly functions: readonly FunctionUnit[];
  /** Highest single-function complexity in the file. */
  readonly peakFunctionComplexity: number;
}

/**
 * A maintainability score in 0–100, higher is better.
 *
 * The classic Halstead-based maintainability index needs operator and operand
 * counts a parser-free analyser cannot obtain reliably, and its `ln(LOC)` term
 * drives any file over ~800 lines to zero regardless of how clean it is —
 * which makes it useless for ranking. ForgeOS instead scores the three
 * properties that actually predict how hard a file is to change, each
 * contributing a bounded penalty so no single dimension can dominate:
 *
 *   - **Complexity density** — decision points per line, not raw complexity.
 *     A 1,000-line file with 200 branches is ordinary; a 60-line file with 40
 *     branches is not.
 *   - **Nesting depth** — the strongest single predictor of misreading.
 *   - **Size** — real but secondary, and heavily damped.
 *
 * Comment density earns back up to 10 points, because an explained file is
 * genuinely cheaper to change than an unexplained one of the same shape.
 */
export function maintainabilityIndex(
  code: number,
  complexity: number,
  commentRatio: number,
  nesting = 0
): number {
  if (code === 0) return 100;

  const density = complexity / code;
  // 0.25 decision points per line is where code stops being scannable.
  const complexityPenalty = clamp(density / 0.25, 0, 1) * 45;
  const nestingPenalty = clamp((nesting - 3) / 5, 0, 1) * 20;
  const sizePenalty = clamp((code - 200) / 1000, 0, 1) * 20;
  const commentBonus = clamp(commentRatio * 2, 0, 1) * 10;

  return round(
    clamp(100 - complexityPenalty - nestingPenalty - sizePenalty + commentBonus, 0, 100),
    1
  );
}

export function analyseFile(path: string, text: string): FileComplexity {
  const language = detectLanguage(path);
  const counts = countLines(text, language);
  const complexity = cyclomaticComplexity(text, language);
  const functions = extractFunctions(text, language);
  const nesting = maxNestingDepth(text, language);
  const commentRatio =
    counts.code + counts.comment === 0 ? 0 : counts.comment / (counts.code + counts.comment);

  return {
    path,
    language: language?.id ?? null,
    code: counts.code,
    comment: counts.comment,
    blank: counts.blank,
    complexity,
    nesting,
    maintainability: maintainabilityIndex(counts.code, complexity, commentRatio, nesting),
    functions,
    peakFunctionComplexity: functions.reduce((max, fn) => Math.max(max, fn.complexity), 0),
  };
}
