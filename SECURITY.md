# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it through GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), which creates a private advisory visible only to maintainers.

Please include:

- What the vulnerability allows an attacker to do
- The steps to reproduce it, ideally with a minimal example
- The affected version or commit
- Any mitigation you have identified

You can expect an acknowledgement within 72 hours and an assessment within seven days. If the report
is valid we will agree a disclosure timeline with you, and credit you in the advisory unless you
prefer otherwise.

## Supported versions

ForgeOS is pre-1.0. Security fixes are applied to `main` and released as a patch version. There is
no long-term support branch yet.

## Scope

In scope:

- Path traversal or sandbox escape in repository scanning
- Server-side request forgery through workflow nodes
- Cross-tenant data access
- Authentication or authorisation bypass
- Injection of any kind in the API layer
- Secrets leaking into logs, error responses, stored reports or generated documents
- Prompt injection that leads to a real capability being exercised, rather than merely to odd text

Out of scope:

- Findings that require an attacker to already have workspace edit access, unless they escalate
  beyond that workspace
- Denial of service through deliberately pathological input to a local analysis run
- Vulnerabilities in dependencies with no exploitable path in ForgeOS, though we still want to know
- Missing hardening headers on a local development server

## Security properties ForgeOS aims to hold

These are the invariants the code is written to maintain. A report that breaks one of them is a
valid vulnerability even if it does not fit a category above.

1. **Repository paths cannot escape their root.** Every resolved path is checked against
   `FORGEOS_SCAN_ROOT`, and directory symlinks are never followed.
2. **Workflows cannot reach private networks.** HTTP and MCP nodes refuse loopback, private and
   link-local destinations, so a workflow is not an SSRF primitive aimed at cloud metadata.
3. **Tool names from a model are never used as a lookup key.** They are resolved through a registry
   the application built; an unknown name raises rather than dispatching.
4. **Tool output is data.** It is inserted beneath an explicit instruction that it must not be
   followed, and instruction-shaped content is surfaced to the user rather than silently removed.
5. **Secrets are never stored in full.** The scanner keeps a redacted preview and nothing else.
6. **Logs are redacted.** Secret-looking keys are replaced before a record reaches any transport.
7. **Every store read is workspace-scoped.** The type system requires it; PostgreSQL enforces it
   again with row-level security.
8. **Internal error detail never reaches a client.** 5xx responses carry a generic message.

## Operating ForgeOS safely

- Set `FORGEOS_SCAN_ROOT` to the narrowest directory that contains the repositories you intend to
  analyse. It defaults to the server's working directory.
- Configure `CLERK_SECRET_KEY` for any deployment reachable by more than one person. Without it,
  ForgeOS runs in single-user local mode and does not authenticate anyone.
- Set `REDIS_URL` when running more than one instance, or the rate limits apply per instance.
- Set `FORGEOS_ENCRYPTION_KEY` before storing any third-party integration credentials.
- Treat any repository you analyse as untrusted input. Analysis does not execute the code it reads,
  but generated documentation may quote it.
