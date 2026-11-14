# Radix package metadata correction

`sparkjsdev-radix-0.0.1.tgz` retains the exact `dist/`, README and MIT license from the npm release `@sparkjsdev/radix@0.0.1`. Only package metadata changes: remove `dependencies`, `devDependencies`, `scripts` and `allowScripts`. The published runtime dependency list consists of development tools and incorrectly makes macOS-only `fsevents` mandatory; it fails installation on Linux and attempts a missing native build on macOS. The browser modules and inline workers already bundle their runtime helpers and import only Three.js, which remains a peer dependency. No renderer code is changed.

Alternate versions selected in the Lab still load their published modules from npm CDN.
