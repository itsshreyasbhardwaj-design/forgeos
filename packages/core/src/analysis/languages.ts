/**
 * Language detection and comment-aware line counting.
 *
 * Counting "lines of code" by splitting on newlines overstates every codebase,
 * often by 30–40%, because licence headers, JSDoc blocks and blank lines all
 * count. ForgeOS instead runs a small per-language lexer that tracks string and
 * comment state, so `code`, `comment` and `blank` are reported separately and
 * the comment ratio becomes a usable documentation signal.
 */
export interface LanguageDefinition {
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  readonly filenames?: readonly string[];
  readonly lineComment?: readonly string[];
  readonly blockComment?: readonly (readonly [string, string])[];
  readonly stringDelimiters?: readonly string[];
  /** Colour used consistently across every chart and graph in the product. */
  readonly color: string;
  readonly category: 'programming' | 'markup' | 'data' | 'config' | 'docs' | 'other';
}

const C_LIKE = {
  lineComment: ['//'] as const,
  blockComment: [['/*', '*/']] as const,
  stringDelimiters: ['"', "'", '`'] as const,
};

const HASH_LIKE = {
  lineComment: ['#'] as const,
  stringDelimiters: ['"', "'"] as const,
};

export const LANGUAGES: readonly LanguageDefinition[] = [
  { id: 'typescript', name: 'TypeScript', extensions: ['.ts', '.mts', '.cts'], color: '#3178c6', category: 'programming', ...C_LIKE },
  { id: 'tsx', name: 'TypeScript (JSX)', extensions: ['.tsx'], color: '#4d9fd6', category: 'programming', ...C_LIKE },
  { id: 'javascript', name: 'JavaScript', extensions: ['.js', '.mjs', '.cjs'], color: '#f1e05a', category: 'programming', ...C_LIKE },
  { id: 'jsx', name: 'JavaScript (JSX)', extensions: ['.jsx'], color: '#f7df1e', category: 'programming', ...C_LIKE },
  { id: 'python', name: 'Python', extensions: ['.py', '.pyi'], color: '#3572a5', category: 'programming', lineComment: ['#'], blockComment: [['"""', '"""'], ["'''", "'''"]], stringDelimiters: ['"', "'"] },
  { id: 'go', name: 'Go', extensions: ['.go'], color: '#00add8', category: 'programming', ...C_LIKE },
  { id: 'rust', name: 'Rust', extensions: ['.rs'], color: '#dea584', category: 'programming', ...C_LIKE },
  { id: 'java', name: 'Java', extensions: ['.java'], color: '#b07219', category: 'programming', ...C_LIKE },
  { id: 'kotlin', name: 'Kotlin', extensions: ['.kt', '.kts'], color: '#a97bff', category: 'programming', ...C_LIKE },
  { id: 'swift', name: 'Swift', extensions: ['.swift'], color: '#f05138', category: 'programming', ...C_LIKE },
  { id: 'csharp', name: 'C#', extensions: ['.cs'], color: '#178600', category: 'programming', ...C_LIKE },
  { id: 'cpp', name: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], color: '#f34b7d', category: 'programming', ...C_LIKE },
  { id: 'c', name: 'C', extensions: ['.c', '.h'], color: '#555555', category: 'programming', ...C_LIKE },
  { id: 'ruby', name: 'Ruby', extensions: ['.rb'], filenames: ['Rakefile', 'Gemfile'], color: '#701516', category: 'programming', lineComment: ['#'], blockComment: [['=begin', '=end']], stringDelimiters: ['"', "'"] },
  { id: 'php', name: 'PHP', extensions: ['.php'], color: '#4f5d95', category: 'programming', lineComment: ['//', '#'], blockComment: [['/*', '*/']], stringDelimiters: ['"', "'"] },
  { id: 'scala', name: 'Scala', extensions: ['.scala', '.sc'], color: '#c22d40', category: 'programming', ...C_LIKE },
  { id: 'elixir', name: 'Elixir', extensions: ['.ex', '.exs'], color: '#6e4a7e', category: 'programming', ...HASH_LIKE },
  { id: 'dart', name: 'Dart', extensions: ['.dart'], color: '#00b4ab', category: 'programming', ...C_LIKE },
  { id: 'shell', name: 'Shell', extensions: ['.sh', '.bash', '.zsh', '.fish'], color: '#89e051', category: 'programming', ...HASH_LIKE },
  { id: 'sql', name: 'SQL', extensions: ['.sql'], color: '#e38c00', category: 'data', lineComment: ['--'], blockComment: [['/*', '*/']], stringDelimiters: ["'"] },
  { id: 'vue', name: 'Vue', extensions: ['.vue'], color: '#41b883', category: 'markup', ...C_LIKE },
  { id: 'svelte', name: 'Svelte', extensions: ['.svelte'], color: '#ff3e00', category: 'markup', ...C_LIKE },
  { id: 'html', name: 'HTML', extensions: ['.html', '.htm'], color: '#e34c26', category: 'markup', blockComment: [['<!--', '-->']] },
  { id: 'css', name: 'CSS', extensions: ['.css'], color: '#563d7c', category: 'markup', blockComment: [['/*', '*/']] },
  { id: 'scss', name: 'Sass', extensions: ['.scss', '.sass'], color: '#c6538c', category: 'markup', ...C_LIKE },
  { id: 'json', name: 'JSON', extensions: ['.json', '.jsonc'], color: '#292929', category: 'data' },
  { id: 'yaml', name: 'YAML', extensions: ['.yml', '.yaml'], color: '#cb171e', category: 'config', lineComment: ['#'] },
  { id: 'toml', name: 'TOML', extensions: ['.toml'], color: '#9c4221', category: 'config', lineComment: ['#'] },
  { id: 'markdown', name: 'Markdown', extensions: ['.md', '.mdx', '.markdown'], color: '#083fa1', category: 'docs' },
  { id: 'dockerfile', name: 'Dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile', 'Containerfile'], color: '#384d54', category: 'config', lineComment: ['#'] },
  { id: 'terraform', name: 'Terraform', extensions: ['.tf', '.tfvars'], color: '#7b42bc', category: 'config', lineComment: ['#', '//'], blockComment: [['/*', '*/']] },
  { id: 'graphql', name: 'GraphQL', extensions: ['.graphql', '.gql'], color: '#e10098', category: 'data', lineComment: ['#'] },
  { id: 'prisma', name: 'Prisma', extensions: ['.prisma'], color: '#0c344b', category: 'data', lineComment: ['//'] },
  { id: 'proto', name: 'Protocol Buffers', extensions: ['.proto'], color: '#4285f4', category: 'data', ...C_LIKE },
];

const BY_EXTENSION = new Map<string, LanguageDefinition>();
const BY_FILENAME = new Map<string, LanguageDefinition>();
const BY_ID = new Map<string, LanguageDefinition>();

for (const language of LANGUAGES) {
  BY_ID.set(language.id, language);
  for (const extension of language.extensions) {
    if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, language);
  }
  for (const filename of language.filenames ?? []) {
    BY_FILENAME.set(filename.toLowerCase(), language);
  }
}

export function getLanguageById(id: string): LanguageDefinition | undefined {
  return BY_ID.get(id);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function detectLanguage(path: string): LanguageDefinition | undefined {
  const base = basename(path).toLowerCase();
  const byName = BY_FILENAME.get(base);
  if (byName) return byName;
  // `Dockerfile.prod` and friends.
  for (const [name, language] of BY_FILENAME) {
    if (base.startsWith(`${name}.`)) return language;
  }
  return BY_EXTENSION.get(extname(path));
}

export interface LineCounts {
  readonly total: number;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
}

/**
 * Count lines with awareness of the language's comment and string syntax.
 *
 * The lexer is deliberately shallow — it tracks whether the cursor is inside a
 * string or a block comment, which is enough to avoid the two classic errors:
 * treating `"http://example.com"` as a line comment, and treating a block
 * comment terminator that appears inside a string literal as a real terminator.
 */
export function countLines(text: string, language?: LanguageDefinition): LineCounts {
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a real line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  if (!language || (!language.lineComment && !language.blockComment)) {
    let blank = 0;
    for (const line of lines) if (line.trim() === '') blank++;
    return { total: lines.length, code: lines.length - blank, comment: 0, blank };
  }

  const lineComments = language.lineComment ?? [];
  const blockComments = language.blockComment ?? [];
  const quotes = language.stringDelimiters ?? [];

  let code = 0;
  let comment = 0;
  let blank = 0;
  let openBlock: readonly [string, string] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      blank++;
      continue;
    }

    let sawCode = false;
    let sawComment = false;
    let index = 0;
    let quote: string | null = null;

    while (index < line.length) {
      if (openBlock) {
        const close = line.indexOf(openBlock[1], index);
        sawComment = true;
        if (close === -1) {
          index = line.length;
        } else {
          index = close + openBlock[1].length;
          openBlock = null;
        }
        continue;
      }

      if (quote) {
        if (line[index] === '\\') {
          index += 2;
          continue;
        }
        if (line.startsWith(quote, index)) quote = null;
        index++;
        continue;
      }

      const rest = line.slice(index);

      const openedQuote = quotes.find((q) => rest.startsWith(q));
      if (openedQuote) {
        sawCode = true;
        quote = openedQuote;
        index += openedQuote.length;
        continue;
      }

      const block = blockComments.find(([open]) => rest.startsWith(open));
      if (block) {
        sawComment = true;
        // A same-line `/* … */` should not leave the block open.
        const close = line.indexOf(block[1], index + block[0].length);
        if (close === -1) {
          openBlock = block;
          index = line.length;
        } else {
          index = close + block[1].length;
        }
        continue;
      }

      if (lineComments.some((marker) => rest.startsWith(marker))) {
        sawComment = true;
        break;
      }

      sawCode = true;
      index++;
    }

    if (sawCode) code++;
    else if (sawComment) comment++;
    else blank++;
  }

  return { total: lines.length, code, comment, blank };
}

export interface LanguageBreakdown {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly files: number;
  readonly code: number;
  readonly comment: number;
  readonly blank: number;
  readonly bytes: number;
  /** Share of total code lines, 0–100. */
  readonly percentage: number;
}

export function summariseLanguages(
  entries: readonly { path: string; text: string | null; bytes: number }[]
): LanguageBreakdown[] {
  const totals = new Map<
    string,
    { language: LanguageDefinition; files: number; code: number; comment: number; blank: number; bytes: number }
  >();

  for (const entry of entries) {
    const language = detectLanguage(entry.path);
    if (!language) continue;
    const counts = entry.text === null ? null : countLines(entry.text, language);
    const bucket = totals.get(language.id) ?? {
      language,
      files: 0,
      code: 0,
      comment: 0,
      blank: 0,
      bytes: 0,
    };
    bucket.files++;
    bucket.bytes += entry.bytes;
    if (counts) {
      bucket.code += counts.code;
      bucket.comment += counts.comment;
      bucket.blank += counts.blank;
    }
    totals.set(language.id, bucket);
  }

  const totalCode = [...totals.values()].reduce((sum, bucket) => sum + bucket.code, 0);

  return [...totals.values()]
    .map((bucket) => ({
      id: bucket.language.id,
      name: bucket.language.name,
      color: bucket.language.color,
      files: bucket.files,
      code: bucket.code,
      comment: bucket.comment,
      blank: bucket.blank,
      bytes: bucket.bytes,
      percentage: totalCode === 0 ? 0 : Math.round((bucket.code / totalCode) * 1000) / 10,
    }))
    .sort((a, b) => b.code - a.code || b.files - a.files || a.name.localeCompare(b.name));
}
