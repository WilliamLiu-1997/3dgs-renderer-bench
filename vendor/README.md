# PlayCanvas snapshot

`playcanvas-2.24.0-beta.30.tgz` contains the official release ESM build and scripts from [PlayCanvas 2.24.0-beta.30](https://github.com/playcanvas/engine/commit/876ba2e7dffc246b1008695f23f60ac1a9b96109), checked on 2026-11-03 (Australia/Sydney).

The archive retains the MIT license and records the full commit in `package.json.gitHead` and the exported `revision`. The lab and harness share one `package.json` and install this same archive. Viewer uses this Engine peer dependency; it does not bring its own Engine copy.

To reproduce the JavaScript build in a checkout of that commit, install its locked development dependencies and run:

```sh
ENGINE_BUILD_REVISION=$(git rev-parse HEAD) node build.mjs --type=rel --format=esm
```

The snapshot packages `build/playcanvas.mjs`, `scripts/` and `LICENSE`, using `build/playcanvas.mjs` as the ESM entry. No Engine source or shader changes are applied.

# Radix package metadata correction

`sparkjsdev-radix-0.0.1.tgz` retains the exact `dist/`, README and MIT license from the npm release `@sparkjsdev/radix@0.0.1`. Only package metadata changes: remove `dependencies`, `devDependencies`, `scripts` and `allowScripts`. The published runtime dependency list consists of development tools and incorrectly makes macOS-only `fsevents` mandatory; it fails installation on Linux and attempts a missing native build on macOS. The browser modules and inline workers already bundle their runtime helpers and import only Three.js, which remains a peer dependency. No renderer code is changed.

Alternate versions selected in the Lab still load their published modules from npm CDN.
