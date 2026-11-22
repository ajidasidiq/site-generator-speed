# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ajidasidiq/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ajidasidiq/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Amba Site Builder: a faster drop-in for make.fun's own makefun-site 1.0.0. For each case's input it returns exactly the output tree makefun-site 1.0.0's build returns — every page's index.html, the index and tag pages, build-report.txt and each static file, byte for byte — in about a third of the reference's CPU time. Direct Markdown rendering with no token objects and first-character block dispatch, inline markup found with native indexOf scans and plain runs escaped in one native pass, front matter sliced out of the source instead of split-and-rejoined, an ASCII fast path for slugs with a per-case memo, templates parsed once into compact opcode arrays, and memoised includes. Dependency-free, deterministic, Node 22 only.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=ajidasidiq&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
