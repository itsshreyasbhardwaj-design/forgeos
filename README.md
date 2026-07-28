<div align="center">

# ForgeOS

**The developer operating system.**
Repository intelligence, documentation, architecture, evaluation, automation, memory, workflows, APIs and security — one platform, one search index, one memory, one AI that can see all of it.

[![CI](https://github.com/itsshreyasbhardwaj-design/forgeos/actions/workflows/ci.yml/badge.svg)](https://github.com/itsshreyasbhardwaj-design/forgeos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Zero config](https://img.shields.io/badge/setup-zero%20config-7c5cff.svg)](#quick-start)

</div>

---

## Why this exists

A working developer uses a repository host, a docs site, a diagramming tool, an API client, a
CI bot, a vulnerability scanner, an evaluation harness and three chat windows — and none of them
know about each other. The docs go stale because nothing checks them against the code. The
architecture diagram is a photo of a whiteboard. The security scanner does not know which module is
load-bearing. The AI assistant cannot see any of it.

ForgeOS is the argument that these are one product. Every module is a projection of one shared
model of your codebase, so the numbers never disagree between panels, and the assistant can answer
questions that span all of them.

## What makes it different

**It runs with an empty environment.** No API key, no database, no account, no signup. Storage
falls back to a local file, the AI provider falls back to a deterministic offline responder, and
every module works. Set an environment variable and that subsystem upgrades at boot — no code
changes, no rebuild. `GET /api/system/health` always tells you exactly what is active.

**It is grounded, not generated.** Every metric, diagram and document is derived from the code in
front of it. Where ForgeOS cannot determine something, it says so and tells you what to fill in.
Generated documentation that quietly invents a deployment process is worse than none, because it is
believed.

**The kernel has zero runtime dependencies.** `@forgeos/core` is pure TypeScript — no parser
toolchain, no native modules — so the same analysis runs in a server component, an edge function, a
CLI, a test, or a plugin sandbox.

---

## Quick start

```bash
git clone https://github.com/itsshreyasbhardwaj-design/forgeos
cd forgeos
pnpm install
pnpm build:packages
pnpm dev
```

Open <http://localhost:3000>. A sample repository is bundled, so every module has real data on the
first run. Nothing is uploaded anywhere; analysis happens in your process, on your machine.

Analyse a real repository from the terminal, without the app:

```bash
pnpm analyze ../some-project
```

```
orders-service — Order capture and fulfilment API for the storefront.

  Stack                  Express · PostgreSQL
  Files                  17 (12.4 KB)
  Lines of code          351
  Health                 35/100 (grade F)
  Module graph           17 nodes, 21 edges
  Circular deps          1
  HTTP routes            6 (express)
  DB entities            4 (sql)
```

---

## Modules

| Module            | What it does                                                                                                                                   | What it replaces                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Repositories**  | Language breakdown, comment-aware LOC, cyclomatic complexity, dependency graph, hotspot ranking, technical-debt findings with effort estimates | Reading the code for three days |
| **Architecture**  | Layered module graph, layer-violation detection, circular-dependency reports, database ERDs, API maps                                          | A whiteboard photo in Slack     |
| **Documentation** | README, architecture, API reference, setup and deployment guides generated from analysis, with explicit gaps for what a human must still write | Docs that went stale in 2023    |
| **API platform**  | OpenAPI 3.1 design, specification linting, a deterministic mock server, request validation, TypeScript and Python SDK generation               | Postman plus a wiki page        |
| **Workflows**     | A DAG engine with conditional branching, retries, timeouts and complete execution traces; nodes wrap every other module, plus HTTP and MCP     | A folder of shell scripts       |
| **Evaluation**    | Prompt and model comparison on quality, latency, tokens and real cost, with reproducible seeds and deterministic scorers                       | Vibes                           |
| **Security**      | Secret detection, insecure-pattern analysis including LLM-specific risks, dependency advisories, OWASP and SOC 2 control mapping               | An annual pen test              |
| **Automation**    | Pull-request review scoped to changed lines, changelogs, release notes, semantic version inference, commit linting                             | Nagging in code review          |
| **Memory**        | Hybrid lexical + vector retrieval, importance decay, a knowledge graph of entities and decisions                                               | Asking the person who left      |

Plus a **command palette** (`⌘K`), **global search** across every entity, and an **assistant**
(`⌘J`) with tool access to all of it.

---

## Architecture

```
forgeos/
├── packages/
│   ├── core/     @forgeos/core — the kernel. Zero runtime dependencies.
│   │             analysis · graph · security · docs · search · memory
│   │             ai · eval · workflow · api · automation · plugins
│   ├── db/       @forgeos/db — storage. Memory, file and PostgreSQL adapters
│   │             behind one interface; pgvector when available.
│   ├── sdk/      @forgeos/sdk — the official TypeScript client.
│   └── ui/       @forgeos/ui — design tokens and primitives.
├── apps/web/     Next.js App Router application and REST API.
├── sdks/python/  The official Python client (standard library only).
└── scripts/      `pnpm analyze` — the engines from a terminal.
```

Data flows one way. A **snapshot** (an immutable set of files) is produced by a scanner, an
**analysis** is computed from the snapshot in a single pass, and every module is a projection of
that analysis. Nothing re-reads the filesystem behind another module's back, which is why two
panels can never disagree about how many modules a repository has.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, including the decisions that were
deliberately _not_ taken and why.

---

## Configuration

Every variable is optional. The defaults are not a degraded demo mode — they are a supported
configuration.

| Variable             | Unset                                        | Set                                                                         |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`       | File storage under `.forgeos/`               | PostgreSQL, with pgvector for semantic memory when the extension is present |
| `OPENROUTER_API_KEY` | `forge-local` — deterministic, offline, free | Hosted models via OpenRouter, alongside the local one                       |
| `CLERK_SECRET_KEY`   | Local single-user session (development)      | Clerk-managed identity; the local fallback is then refused                  |
| `REDIS_URL`          | In-process rate limiting, per instance       | Shared limits across instances                                              |
| `TRIGGER_SECRET_KEY` | Inline job execution                         | Durable background execution                                                |
| `FORGEOS_SCAN_ROOT`  | The server's working directory               | Widens which paths may be analysed                                          |

ForgeOS never calls a paid provider unless you configured one and the request named it.

---

## Developer guide

```bash
pnpm build:packages   # compile the workspace packages
pnpm dev              # run the app
pnpm test             # unit and integration tests (vitest)
pnpm test:e2e         # end-to-end tests (playwright)
pnpm typecheck        # strict TypeScript across the workspace
pnpm lint             # eslint
pnpm verify           # everything above, in the order CI runs it
```

**Conventions.** Strict TypeScript with `noUncheckedIndexedAccess`. Expected failures return a
`Result`; exceptions are for programmer error. Every engine is a pure function of its input, which
is why they are testable without mocks and deterministic across runs. Comments explain _why_, not
what.

**Adding a module.** Add its engine to `packages/core/src/<module>/`, export it from the barrel,
register the module in `apps/web/src/lib/modules.ts`, and it appears in navigation, the command
palette and search automatically.

**Adding a workflow node.** Implement a `NodeTypeDefinition` in
`apps/web/src/lib/server/workflow-nodes.ts`. It becomes available in the builder immediately.

---

## Benchmarks

Measured on an Apple silicon laptop. The figure is the **analysis** pass alone — scanning,
language detection, complexity, import resolution, graph construction, layering, cycle detection,
debt rules and duplicate detection — as the mean of three warm runs over an in-memory snapshot.
Reading the files from disk is separate and dominated by the filesystem.

| Repository | Files | Lines of code | Analysis | Throughput |
| --- | ---: | ---: | ---: | ---: |
| radius | 26 | 1,334 | 21 ms | ~64k LOC/s |
| agentsecbench | 53 | 2,410 | 25 ms | ~96k LOC/s |
| devgraph | 123 | 20,974 | 277 ms | ~76k LOC/s |
| gitbrain | 166 | 29,798 | 380 ms | ~78k LOC/s |

Reproduce with `pnpm analyze <path>`; the duration is printed at the end.

The health score is a saturating function of severity-weighted findings per thousand lines, chosen
so the full 0–100 range stays in play. Across the repositories above it spans 26–79 — a linear
penalty pins every real codebase at zero and stops being comparable.

---

## Roadmap

- [ ] Git provider ingestion (GitHub, GitLab) alongside local paths
- [ ] Incremental re-analysis keyed on content hashes, instead of full re-scan
- [ ] Real-time collaborative editing for documents, with presence
- [ ] A plugin marketplace and a signed distribution format
- [ ] Tree-sitter parsers behind the existing interfaces, for exact call graphs
- [ ] Scheduled workflows and webhook triggers
- [ ] Hosted embeddings, for retrieval that spans vocabulary rather than lexicon

---

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the
architecture, the conventions, and the parts of the codebase that are most approachable if you are
new.

Security issues should not go in a public issue; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
