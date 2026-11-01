# Frozen entity-resolution system

`frozen/` holds `normalize.ts`, `rules.ts` and `resolve.ts` exactly as they were frozen (commit `bc72dd4`) before the
held-out set was generated. They are byte-identical copies: their SHA-256 (computed the same way as for
`src/server/er/`) equals `frozenSystemSha` in [`../heldout.meta.json`](../heldout.meta.json), and a unit test checks it.

The blind held-out section of the evals is recorded and replayed with these files, so later fixes to the live system
in `src/server/er/` cannot change, or silently improve, the blind numbers. Every other section runs the live system.
Do not edit these files: change `src/server/er/` and publish the result as a labelled, non-blind section instead.
