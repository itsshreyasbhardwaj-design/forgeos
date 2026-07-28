# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — Unreleased

The first release. Nine modules over one kernel, running with zero configuration.

### Added

- **Kernel** (`@forgeos/core`) — zero-runtime-dependency analysis engines: filesystem snapshots,
  language detection with comment-aware line counting, cyclomatic complexity, import extraction and
  resolution, package manifests across eight ecosystems, stack detection, technical-debt rules and
  a module graph with cycle and layer-violation detection.
- **Security** — secret detection with provider patterns and entropy analysis, insecure-code
  patterns including four LLM-specific rules, an offline advisory set with semver range matching,
  and OWASP / OWASP-LLM / SOC 2 control mapping.
- **Documentation** — README, architecture, API, setup and deployment generators that report the
  gaps they cannot fill rather than inventing content.
- **Search and memory** — BM25 search across every entity, plus hybrid lexical and vector retrieval
  with reciprocal rank fusion, importance decay and a knowledge graph.
- **AI** — a provider abstraction with a deterministic offline provider (`forge-local`) and an
  OpenRouter adapter, and a tool-calling assistant with allowlisted dispatch and prompt-injection
  annotation.
- **Workflows** — a DAG engine with a safe expression language, conditional edges, retries,
  timeouts and full execution traces; built-in nodes for every module plus HTTP and MCP.
- **API platform** — OpenAPI 3.1 modelling, linting, a deterministic mock server, request
  validation, and TypeScript, Python, curl and Markdown generation.
- **Evaluation** — a reproducible benchmark harness with deterministic scorers and cost projection.
- **Automation** — conventional-commit parsing, changelog and release-note generation, and
  pull-request review scoped to changed lines.
- **Persistence** (`@forgeos/db`) — one storage interface over memory, file and PostgreSQL adapters,
  with pgvector support and row-level security policies.
- **Clients** — `@forgeos/sdk` for TypeScript and `forgeos` for Python, both dependency-free.
- **Application** — Next.js App Router UI with a command palette, global search, an assistant panel,
  light and dark themes, and a REST API.
