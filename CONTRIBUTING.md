# Contributing

## Development

Use the Bun version specified in `package.json`. Create a short-lived branch from the latest `main`, such as `feat/gui`, `fix/balance`, or `chore/dependencies`.

Run the local checks before opening a pull request:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

Use `bun run format` to fix source formatting. The test command succeeds when no tests exist. See [README.md](README.md) for runtime configuration.

## Code guidelines

- Keep changes focused, readable, and consistent with the surrounding code.
- Reuse existing helpers; avoid unnecessary abstractions and repeated validation.
- Put named types and interfaces after imports, and group functions by responsibility.
- Add comments for non-obvious behavior rather than restating the code.
- Never commit credentials, private keys, wallet files, or local `.env` files.

## Pull requests and releases

- Explain what changed and why, including any compatibility changes.
- Increase `package.json`'s version above `main`: patch for fixes, minor for compatible features, major for breaking changes.
- Ensure CI passes, address review feedback, and resolve conversations before merging.
- PRs are squash-merged by the maintainer. Delete the feature branch after merging.

A successful merge to `main` automatically publishes the npm package and creates the corresponding Git tag and GitHub Release. `bot -v` uses the version from `package.json`.
