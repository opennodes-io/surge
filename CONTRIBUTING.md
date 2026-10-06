# Contributing to Surge

Thanks for helping. Surge is pre-release, so expect things to move; small, focused pull requests are the easiest to land.

## Setup

Needs Node.js 22.5 or newer, pnpm 10 (`corepack enable`) and Git.

```bash
pnpm install
pnpm --filter @surge/desktop dev
```

A local Ollama is useful for private mode; the hosted OpenNodes registry needs nothing.

## Before you open a pull request

```bash
pnpm typecheck                     # every package
pnpm test                          # hermetic verification scripts (no network, no API keys)
pnpm --filter @surge/desktop build # the desktop app still builds
```

If you touch packaging or the desktop app's `dependencies`, also run `pnpm --filter @surge/desktop dist:win` on Windows. Its `afterPack` check fails the build if the installer would ship a missing or mismatched module.

CI runs the checks above on every pull request. If you change the UI, check it in the running app and add a screenshot to the pull request. New behavior in `@surge/core` should come with a check in one of the `packages/core/test/verify-*.ts` scripts (they use mock servers, so they stay hermetic).

## Ground rules

- **Keep `@surge/core` platform-agnostic.** It's shared by the desktop, the mobile scaffold and the standalone server: no Electron or DOM assumptions. Node-only OpenNodes code (`onp-client.ts`, `onp-advisor.ts`) stays behind the `onp` / `ai` subpaths, never `ui` / `discovery`.
- **Open an issue before adding a dependency to `@surge/core`** — every consumer bundles it.
- **Follow the OpenNodes spec** ([ONP-1..6](https://github.com/opennodes-io/opennodes/tree/main/spec)): invocation goes directly to the node, every call is pinned, receipts are verified, and claimed, measured and attested values are never blended — show the basis.
- **Never commit secrets.** Keys belong in the keychain-backed secret store, not in code, fixtures or the settings file.
- One concern per commit, with a message that says what changed and why.

`CLAUDE.md` holds the working notes for AI coding agents — current state, known issues and gotchas. It's worth a read for humans too.

## Releasing (maintainers)

1. Bump `version` in `apps/desktop/package.json` in a pull request and merge it.
2. Tag the merge commit and push the tag: `git tag v<version> && git push origin v<version>`. Use the GitHub remote's name, if yours isn't `origin`.
3. The **Release** workflow builds the installer on Windows (typecheck, tests, `dist:win` and its module check). It attaches the installer, its blockmap and `SHA256SUMS.txt` to a **draft pre-release**. If the tag doesn't match the version, the workflow fails.
4. Review the draft's notes, try the installer, and publish the release. Nothing is public until you do.

## Reporting bugs and ideas

Open an issue with what you did, what you expected and what happened (and your OS). Security problems go through [SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of the project.
