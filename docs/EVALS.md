# Entity-resolution evals

Frozen dataset: `evals/dataset.json` — 169 entries (each a different PayPal account) in 121 true people/operations.
SHA-256 `b8367bedadcf68570acc6e2766bbf3b0bfe00791883d5b131b4a21d04afb0dbd`. Generator: syntheticCrowd(seed 20261112) + LLM red-team rewrites of reseller networks (42 rewrites accepted).

| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| Exact match (raw address / email) | 100.0% | 12.2% | **21.7%** | 0 | 108 | 0.0% | 83.3% | 0 | 0.0s |
| Normalisation + rules (no AI) | 90.4% | 100.0% | **95.0%** | 13 | 0 | 100.0% | 100.0% | 0 | 0.2s |
| Paylet: rules + AI adjudication (MiMo-V2.6-Pro) | 100.0% | 100.0% | **100.0%** | 0 | 0 | 100.0% | 100.0% | 17 | 31.3s |

- Ground truth: 123 account pairs that belong to the same household or reseller operation.
- Only 52 fuzzy pairs (out of 14196) were sent to the model; everything else is decided by deterministic rules.
- Hard negatives include neighbours in different apartments of one building and identical common names in different cities.
- In production nothing is auto-merged: these suggestions go to the seller, and fans can appeal.

Run on 2026-10-31T23:50:35.943Z with `primalabs-ai/MiMo-V2.6-Pro`. Reproduce with `pnpm evals` (needs an OpenAI-compatible key in `.env`).
Metrics are pairwise over the transitive closure (what an allocation system would actually merge).
