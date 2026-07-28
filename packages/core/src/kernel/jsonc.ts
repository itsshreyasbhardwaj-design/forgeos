/**
 * JSON with comments and trailing commas — the dialect `tsconfig.json`,
 * `.eslintrc.json`, `devcontainer.json` and friends are actually written in.
 *
 * A regex-based comment stripper is wrong here in a way that bites immediately.
 * A TypeScript path mapping such as the `paths` entry `"@/x"` -> `"./src/x"`
 * uses glob wildcards, so the file contains comment-open and comment-close
 * sequences *inside string literals*. A naive block-comment regex therefore
 * deletes the middle of the file and the parse fails. This scanner tracks
 * string state, so it cannot make that mistake.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index] as string;

    if (inString) {
      out += char;
      if (char === '\\') {
        // Preserve the escaped character verbatim.
        out += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index++;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      // Preserve newlines so error positions stay meaningful.
      const skipped = text.slice(index, end === -1 ? text.length : end + 2);
      out += skipped.replace(/[^\n]/g, '');
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    out += char;
    index++;
  }

  return out;
}

/** Remove trailing commas before `}` or `]`, which JSON.parse rejects. */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index] as string;

    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index++;
      continue;
    }

    if (char === ',') {
      const rest = text.slice(index + 1);
      const nextNonSpace = /^\s*([}\]])/.exec(rest);
      if (nextNonSpace) {
        // Drop the comma, keep the whitespace so positions barely shift.
        index++;
        continue;
      }
    }

    out += char;
    index++;
  }

  return out;
}

/** Parse JSONC, returning `null` rather than throwing on malformed input. */
export function parseJsonc<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text))) as T;
  } catch {
    return null;
  }
}
