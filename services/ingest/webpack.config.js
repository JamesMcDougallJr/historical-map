const path = require("node:path");
const nodeExternals = require("webpack-node-externals");

/**
 * Nest's default webpack config externalizes `node_modules` using
 * `webpack-node-externals`, which scans exactly one directory: the one next to
 * the build. In an npm-workspaces monorepo that is wrong, and wrong in a way
 * that produces a confusing runtime failure rather than a build error.
 *
 * npm hoists most dependencies to the repo root but leaves some nested under
 * `services/ingest/node_modules`. With only the local directory scanned,
 * hoisted packages are not recognised as externals and get **bundled**, while
 * nested ones stay **external**. `@nestjs/core` (hoisted, bundled) and
 * `@nestjs/typeorm` (nested, external) then each end up with a different
 * `ModuleRef` class object — and because Nest's DI matches providers by class
 * identity, resolution fails at boot with:
 *
 *   Nest can't resolve dependencies of the TypeOrmCoreModule
 *   (TypeOrmModuleOptions, ?) — argument ModuleRef at index [1]
 *
 * Scanning both directories keeps every third-party package external and
 * consistent. It also shrinks each bundle from ~2.8MB to the app's own code.
 */
const workspaceModules = path.resolve(__dirname, "node_modules");
const rootModules = path.resolve(__dirname, "../../node_modules");

/**
 * `@historical-map/*` must stay *bundled*, not externalized. Those packages
 * ship TypeScript source rather than a build artifact, so a runtime
 * `require()` of one would resolve through the workspace symlink to a `.ts`
 * file that Node cannot load. Allowlisting them means webpack compiles them in,
 * which is the same treatment the `@app/*` tsconfig-path libs already get.
 */
const bundleAnyway = [/^@historical-map\//];

module.exports = (options) => ({
  ...options,
  externals: [
    nodeExternals({ modulesDir: workspaceModules, allowlist: bundleAnyway }),
    nodeExternals({ modulesDir: rootModules, allowlist: bundleAnyway }),
  ],
});
