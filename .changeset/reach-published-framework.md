---
'@kernhq/module-inventory': patch
---

fix: raise @kernhq ranges to what is published

A caret on 0.x never crosses a minor, so `@kernhq/ui: ^0.8.0` could not install the published 0.9.0. Raised it to `^0.9.0`.
