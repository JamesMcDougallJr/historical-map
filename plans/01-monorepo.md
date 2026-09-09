# Phase 1 — Monorepo · **Implemented**

Turn the repo into a workspace that can hold the web app, the ingestion services, and the code
they share, **without changing anything about how the web app deploys**.

## Layout

```
/                          root package = the Next.js web app (unchanged in place)
├─ nx.json                 Nx in package-based mode — task runner only
├─ packages/
│  └─ domain/              @historical-map/domain — shared types, zero dependencies
├─ services/               (empty — services/ingest lands in phase 2)
└─ plans/                  this directory
```

## What was done

- `package.json` gains `"workspaces": ["packages/*", "services/*"]`, a `name`, and
  `@historical-map/domain` as a dependency. Existing scripts are untouched; `type-check:all`,
  `build:all`, and `graph` are added as Nx fan-outs.
- `packages/domain` holds the event vocabulary (moved out of `app/map/types.ts`) plus the new
  ingestion vocabulary. It ships **TypeScript source, not a build artifact** — Next compiles it
  via `transpilePackages`, and the Nest workspace will pick it up through a tsconfig path. That
  means neither side has to build it first, and there is no `dist/` to go stale.
- `app/map/types.ts` re-exports it with `export type *`, so **every existing
  `@/app/map/types` import keeps working unchanged**. `export type *` (not `export *`) erases
  at compile time, so nothing in the browser bundle has to resolve the workspace package at
  runtime. The web-app-only types (`EventLayer`, `HistoricalOverlay`, `ProcessingJob`, …) stay
  where they were — the ingestion side has no opinion on how events are served or drawn.
- Build artifacts (`tsconfig.tsbuildinfo`, `mcp/tsconfig.tsbuildinfo`) untracked, and
  `.nx`/`*.tsbuildinfo` added to `.gitignore`.

## Why not Nx-owning-the-build

Nx is present, but **package-based**: no `@nx/next` plugin, no executors, no generated project
targets. Every target it runs is a plain `package.json` script.

The alternative — letting Nx own the Next build — buys generators and computation caching but
puts an Nx plugin between Next 16/Turbopack and the build. This app runs Next 16, Tailwind 4
alpha, and a separate Vite bundle for the MCP App (`vite.config.mcp.ts`), which is exactly the
configuration an Nx Next plugin is most likely to lag. Package-based mode gets the dependency
graph and caching with none of that exposure, and reverting it is deleting one file.

## Why the web app stays at the root

Moving it to `apps/web` is the conventional layout, and it was rejected on deployment risk, not
taste. Vercel's **Root Directory is a project-wide setting**, not per-branch: flipping it to
`apps/web` breaks production until the move merges, and leaving it at the root breaks the PR's
preview build. There is no ordering of those two changes that avoids a window of broken
deploys, and no way to test the new setting on a preview first.

The monorepo goal — one repository holding every part of the stack — is fully met with the web
app as the root package. If the relocation is wanted later it is one commit plus one dashboard
change, best done as its own deliberate step.

## Deployment safety

`vercel.json` now pins both commands:

```json
"installCommand": "npm ci",
"buildCommand": "npm run build"
```

Vercel infers its build from whatever monorepo tooling it detects, and there is now an
`nx.json` at the root for it to detect. Pinning means adding a workspace can never silently
change how the web app is built. `framework`, `regions`, and the per-function `maxDuration`
/`memory` settings are unchanged.

**Known cost:** `npm ci` at the root installs every workspace's dependencies, so once
`services/ingest` exists Vercel will install NestJS and BullMQ it does not use — on the order
of tens of seconds per build. Accepted for now in exchange for one lockfile and no version
skew on dependencies both sides share (`zod`, `typescript`). If it becomes annoying, the fix
is a narrower `installCommand`, not splitting the repo.

## Verification

- `npm run type-check` — passes.
- `npm run build` — passes (`prebuild` → `build:mcp` → `next build`).
- `node_modules/@historical-map/domain` symlinks to `packages/domain`.
