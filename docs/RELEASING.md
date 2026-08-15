# Releasing DSH Agent Mesh

This repository is publishable as a GitHub source repository and as an npm
package. The GitHub repository URL is intentionally not hard-coded until the
maintainer creates the destination repository.

## First GitHub publication

```bash
git init
git add .
git commit -m "chore: prepare dsh agent mesh for release"
git branch -M main
git remote add origin <github-repository-url>
git push -u origin main
```

Replace `<github-repository-url>` with the real repository URL; do not commit a
placeholder URL to `package.json`.

## Versioned release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm run check`,
   `pnpm run build`, and `pnpm run pack:check`.
3. Commit the release and create an annotated tag:

   ```bash
   git tag -a v0.1.0 -m "dsh-agent-mesh v0.1.0"
   git push origin main --follow-tags
   ```

4. Install from GitHub in DSH:

   ```bash
   dsh plugin --profile web add <github-repository-url>
   ```

The package's `dsh` metadata mounts the host Cordis plugin and the browser
bundle. No separate DSH fork or app patch is required.
