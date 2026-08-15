# Contributing

## Development setup

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run check
pnpm run build
pnpm run pack:check
```

The package is a DSH Cordis plugin. Keep the host entry, browser entry, and
`cordis.patch.yml` contract aligned when changing plugin wiring.

## Pull requests

- Explain the user-visible behavior and the affected harness/protocol.
- Add or update focused tests for protocol, recovery, routing, or security
  changes.
- Keep credentials, private transcripts, and machine-specific state out of
  commits and fixtures.
- Run the full commands above before opening a pull request.
