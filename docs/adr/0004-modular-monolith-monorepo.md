# ADR-0004: Modular monolith in a pnpm TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

A single developer is building the brain, several bodies and shared libraries. Microservices would add operational cost with no benefit at this stage.

## Decision

- **One deployable brain** with internal modules (`gateway`, `bodies`, `events`, later `orchestrator`, `llm`, `voice`, `memory`, `skills`, `policy`). Modules talk through explicit interfaces and the event bus.
- **pnpm workspaces**: `apps/*` (brain, bodies) and `packages/*` (protocol, character, persona).
- **TypeScript** (strict), run directly with `tsx`. Workspace packages export their TypeScript source, so there's no build step during development. A single root `tsconfig.json` typechecks everything.
- Tooling: Vitest, ESLint (typescript-eslint), Prettier, GitHub Actions.
- TypeScript is pinned to `~6.0` until typescript-eslint supports TypeScript 7.

## Consequences

- Fast iteration: one `pnpm check` covers the whole system.
- A production build (bundling with tsup/esbuild) is needed before deploying the brain somewhere other than a dev machine.
- If a module ever needs to scale on its own, its interface already marks where to split it out.
