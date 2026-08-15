# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a credential leak, arbitrary command
execution, session-boundary bypass, or other security-sensitive report. Contact
the repository maintainers privately through the GitHub security advisory flow
after the repository has been published.

Include the affected version, a minimal reproduction, impact, and whether any
native credential or session data may have been exposed. Do not include real
API keys, OAuth tokens, cookies, or private transcripts.

## Security boundaries

- Native credentials stay in each harness's existing store and environment.
- Discovery exposes model metadata and non-secret paths only.
- Permission replies default to rejection.
- Automatic routes are bounded by calls, branches, context, and deadlines.
- Persisted events contain normalized projections, not raw protocol payloads or
  child-process environments.
