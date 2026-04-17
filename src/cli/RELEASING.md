# Releasing @alook/cli

Releases are triggered by pushing a tag of the form `cli/vX.Y.Z`:

```bash
git tag cli/v0.2.0
git push origin cli/v0.2.0
```

The [`Publish CLI`](../../.github/workflows/publish-cli.yml) workflow will:

1. Validate the tag format (`cli/vX.Y.Z` or `cli/vX.Y.Z-prerelease`)
2. Set `src/cli/package.json` version to the tag's version (in-job, not committed)
3. Build the Node ESM bundle (inlines `@alook/shared` and its deps)
4. Publish `@alook/cli@X.Y.Z` to npm via **OIDC + provenance**
5. Create a GitHub Release with auto-generated notes

No npm token lives in CI. The package is registered with [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) on npmjs.com.

## Prerelease versions

Use tags like `cli/v0.2.0-beta.1` or `cli/v1.0.0-rc.1`. The npm `latest` dist-tag is **not** automatically moved for prereleases — users pin with `npm i @alook/cli@0.2.0-beta.1`.

If you want a `next` dist-tag, pass `--tag next` to the publish step (requires editing the workflow).

## First publish (bootstrap, one-time)

Before Trusted Publishers can be configured on npmjs.com, the package has to exist. The first publish is manual:

```bash
cd src/cli
pnpm run build
npm login                          # or export an automation token
npm publish --access public        # no --provenance for bootstrap
```

Then on npmjs.com → **@alook/cli** → **Settings** → **Trusted Publishers** → add a GitHub Actions publisher with:

- Repository: `alookai/alook`
- Workflow filename: `publish-cli.yml`
- Environment: `npm-publish`

Also create the `npm-publish` environment in **GitHub → Settings → Environments** (required-reviewer protection optional).

After that, all subsequent releases go through the tag workflow.

## Rolling back

Within 72h of publishing, you can unpublish a specific version:

```bash
npm unpublish @alook/cli@0.2.0
```

After 72h, use deprecation instead:

```bash
npm deprecate @alook/cli@0.2.0 "broken release, please upgrade to 0.2.1"
```

## Local smoke test before tagging

```bash
cd src/cli
pnpm run build
node dist/index.js --help
npm pack --dry-run          # inspect the tarball contents
```
