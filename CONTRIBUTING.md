# Contributing to Ms. Minutes

Thanks for wanting to help. Bug reports, ideas, new bodies and fixes are all welcome.

## Before you start

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for how the brain, the bodies and the Body Protocol fit together.
- Bigger changes (a new body, a protocol change, a new module) deserve an issue first, so we can agree on the shape before you write the code.
- A decision that changes the architecture gets an ADR in [docs/adr](docs/adr), starting from [the template](docs/adr/0000-template.md).

## Setting up

Follow [Getting started](README.md#getting-started) in the README. You can work on almost everything without an API key: run her on [Ollama](https://ollama.com), and the tests use fake models.

## Making a change

1. Fork the repo and branch from `main`.
2. Keep the change focused; one concern per pull request.
3. Add or update tests next to the code you touched (`apps/*/test`, `packages/*/test`).
4. If you change the protocol in `packages/protocol`, run `pnpm schema:generate` and commit the regenerated JSON Schema. If you change the face rig in `packages/character`, run `pnpm firmware:presets`.
5. Run `pnpm check` (typecheck, lint, format check and tests; the same as CI). For firmware changes, also run `pnpm firmware:check`.
6. Open a pull request describing what changed and why.

## Style

Prettier and ESLint decide formatting; `pnpm format` fixes most of it. Match the surrounding code: small modules, plain names, comments that explain why rather than what.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
