# Contributing

Thanks for considering it. This document covers what you need to be productive quickly, and points
at the parts of the codebase that are most approachable if you are new to it.

## Getting set up

```bash
git clone https://github.com/itsshreyasbhardwaj-design/forgeos
cd forgeos
pnpm install
pnpm build:packages
pnpm dev
```

You need Node 20.11+ and pnpm 9+. You do not need a database, an API key or an account — that is a
deliberate property of the project, and if you find a code path that breaks it, that is a bug worth
reporting.

Before opening a pull request:

```bash
pnpm verify   # build, typecheck, lint, unit tests, app build
```

End-to-end tests need a build first:

```bash
pnpm --filter @forgeos/web build
pnpm test:e2e
```

## Where to start

Good first contributions, roughly in order of how self-contained they are:

- **A language.** Add an entry to `LANGUAGES` in `packages/core/src/analysis/languages.ts`, and an
  import-extraction rule in `imports.ts` if the language has imports. Both are data-driven.
- **A stack signature.** Add to `SIGNATURES` in `analysis/stack.ts` to detect another framework.
- **A security rule.** Add to `SECURITY_PATTERNS` in `security/patterns.ts`. Every rule needs a
  concrete remediation, and a test proving it does not fire on the safe form of the same code.
- **An advisory.** Add to `BUNDLED_ADVISORIES` in `security/advisories.ts`, with an accurate range.
- **A workflow node.** Implement a `NodeTypeDefinition` in
  `apps/web/src/lib/server/workflow-nodes.ts`; it appears in the builder immediately.
- **A scorer.** Add to `runScorer` in `eval/harness.ts` for a new way to evaluate model output.

Larger areas that need work are listed in the README roadmap.

## Conventions

**TypeScript is strict**, including `noUncheckedIndexedAccess`. Array access returns `T | undefined`
and you must handle it. This is not pedantry — most of the crashes it prevents are in exactly the
loop-and-index code that analysis engines are made of.

**Expected failures return a `Result`.** Exceptions are for programmer error and genuinely
exceptional I/O. If a caller can reasonably be expected to handle a failure, it should not have to
write a try/catch to discover it exists.

**Engines are pure functions.** Given the same snapshot they must produce the same output, including
ids. If you need the current time, take a `now: () => number` parameter with a default. Determinism
is what makes results cacheable, diffable and testable.

**Comments explain why.** The what is in the code. A comment that restates the line above it is
noise; a comment that records why a threshold is 0.25 rather than 0.5 saves the next person an hour.

**Never claim more than the code does.** If a technique cannot determine something, say so in the
output. The documentation generators list their gaps; the compliance report marks unassessed
controls as unassessed; the local AI provider says when the answer is not in its context. Please
maintain that standard — it is the project's most important property.

## Tests

Unit tests live beside what they test (`foo.ts` → `foo.test.ts` or a suite file per area). A test
should assert behaviour a user could notice, not the shape of an internal function.

When you fix a bug, add a test that fails without the fix and say so in a comment. Several existing
tests are annotated `// Regression:` for exactly this reason.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat(analysis): detect Zig source files
fix(security): stop flagging sanitised HTML injection
docs(readme): correct the benchmark methodology
```

The types in use are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci` and `chore`.
Append `!` or add a `BREAKING CHANGE:` footer for breaking changes — the release tooling reads them
to infer the version bump.

In the pull request, describe what changed and why. If it affects analysis output, include a
before-and-after from `pnpm analyze` on a real repository; that is the fastest way for a reviewer to
see the effect.

## Reporting bugs

Include the ForgeOS version, what you ran, what you expected and what happened. For analysis bugs, a
minimal repository that reproduces the wrong output is worth more than a paragraph of description —
`pnpm analyze` output pasted into the issue is ideal.

Security vulnerabilities do **not** go in public issues. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
