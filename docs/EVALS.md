# Entity-resolution evals

**Held-out, blind (never used for tuning): precision 95.6% ± 0.8, recall 83.3% ± 1.6, F1 89.1% ± 0.6 over 3 runs; false merges 2.7 on average, 3 in the worst run (rules alone: 11); 4 failure modes, 4 explained below.**
After one labelled, non-blind fix (token budget only): precision 95.3% ± 0.2, recall 86.2% ± 3.3, F1 90.5% ± 1.9; false merges 3.0 on average, 3 in the worst run.
On the dev set (the one we tuned on) the AI review takes rules-only false merges from **13 → 0.0** (mean of 3 runs) with no missed links.

## `evals/results.json` shape (read by `/evals`)

```ts
interface Stat { mean: number; sd: number; min: number; max: number }          // sd = sample standard deviation over runs
interface SystemResult {
  id: "exact" | "rules" | "paylet"; system: string;
  precision: number; recall: number; f1: number;                              // 0..1; for "paylet" = mean over runs
  falseMerges: number; missedLinks: number;                                   // pairs; for "paylet" = mean (may be fractional)
  llmCalls: number; ms: number;                                               // for "paylet" = mean per run
  recallByKind: { reshipper_network: number; household: number };            // for "paylet" = worst run
  falseMergeKinds: Record<string, number>;                                    // for "paylet" = worst run
  runs?: { run: number; precision: number; recall: number; f1: number; falseMerges: number; missedLinks: number;
           llmCalls: number; ms: number; keptApart: number; degraded: string | null }[];   // "paylet" only
  stats?: Record<"precision" | "recall" | "f1" | "falseMerges" | "missedLinks", Stat>; // "paylet" only
  worstRun?: number;                                                          // 1-based, lowest F1
}
interface DatasetSection {
  dataset: { sha256: string; entries: number; groups: number; kinds: Record<string, number>; generator: string; frozenAt: string;
             seed?: number; origins?: Record<string, number>; frozenSystemSha?: string; frozenSystemCommit?: string };
  truthPairs: number; uncertainPairs: number; totalPairs: number; results: SystemResult[];
  recordedAt: string; systemSha: string;                                      // when / with which system files the model runs were recorded
  changes?: string[];                                                         // labelled variants only (heldOutAfterFix)
}
interface ExampleEntry { id: string; name: string; address: string; source: string; origin: "generated" | "redteam" | "handwritten";
                         group: string /* ground-truth group */; note?: string }
interface Failure {
  kind: "false_merge" | "missed_link"; dataset: string; key: string; runs: string /* "3/3 runs" */; runCount: number;
  decidedBy: "rules" | "ai" | "ai_unavailable" | "none";                       // main cause
  pairsAffected: number; entries: ExampleEntry[]; detail: string; analysis: string | null /* written by us after the run */;
}
interface Example {
  type: "linked" | "kept_apart" | "failure"; dataset: string; title: string; entries: ExampleEntry[];
  decidedBy: "rules" | "ai" | "ai_unavailable" | "none"; verdict: string; confidence: number | null; reason: string;
  evidence?: { field: string; detail: string }[]; truth: "same" | "different"; correct: boolean; runsObserved: string;
  analysis?: string | null;
}
interface HeldOutHeadline { precision: Stat; recall: Stat; f1: Stat; falseMerges: Stat; missedLinks: Stat; falseMergesRules: number;
                            failures: number; failuresExplained: number }
interface EvalResults extends DatasetSection {                                 // top level = dev set (schema v1 fields kept)
  schemaVersion: 2; ranAt: string; replayedAt?: string; mode: "live" | "replay"; model: string; runs: number;
  system: { sha256: string /* recorded */; files: string[]; current: string /* sha of the files in this checkout */ };
  cassette: { file: string; calls: number };
  heldOut: (DatasetSection & { frozenSystemSha: string | null; systemUnchangedSinceFreeze: boolean; failures: Failure[] }) | null;
  heldOutAfterFix: (DatasetSection & { failures: Failure[] }) | null;          // same file, after a labelled fix: NOT blind
  headline: {
    falseMergesRulesDev: number; falseMergesPayletDev: Stat;                   // tile: "False merges 13 → 0"
    heldOut: HeldOutHeadline | null;                                          // tile: "Held-out: P x% · R y% · n failures explained"
    heldOutAfterFix: HeldOutHeadline | null;
  };
  examples: Example[];                                                         // linked, kept_apart, then failure(s)
  notes: string[];
}
```

## Protocol

1. **Dev set** — `evals/dataset.json` (169 entries, 121 true people/operations; SHA-256 `b8367bedadcf6857…`). syntheticCrowd(seed 20261112) + LLM red-team rewrites of reseller networks (42 rewrites accepted). The rules and the adjudication prompt were developed against this set, so its numbers are optimistic by construction.
2. **Held-out set (blind)** — `evals/heldout.json` (162 entries, 127 true groups; SHA-256 `01348dbb561db1c1…`), frozen 2026-11-01T02:12:44.744Z and committed before any evaluation on it. syntheticCrowd(seed 20261101) + LLM red-team template v2 (23 rewrites accepted; half the networks human-paced) + 33 hand-written hard cases. It was generated **after** the system files (`src/server/er/normalize.ts`, `src/server/er/rules.ts`, `src/server/er/resolve.ts`) were frozen at SHA-256 `4a19fe329f53ae17…`; the blind runs used system `4a19fe329f53ae17…` (unchanged since the freeze). The hand-written cases were written by the same team that wrote the rules, so this is an adversarial test, not a naive one. A first generation of this file was discarded before any evaluation because the red-team validator let a degenerate 3,000-character "address" through; the validator now rejects such rewrites.
3. **3 runs** — the model (temperature 0.1) is called 3 independent times per dataset; we publish mean ± sample standard deviation and the worst run. The baselines are deterministic.
4. **Replay** — every model answer (and every failed call) is stored in `evals/cassette.json` with the exact input it answered. `pnpm evals --replay` re-scores from the cassette with no key, no network and no app config, and fails if the numbers differ from `evals/results.json`; a unit test runs the same check in CI.
5. Metrics are pairwise over the transitive closure (what an allocation system would actually merge). A **false merge** takes a real fan's chance away; a **missed link** lets an operation enter more than once.

## Held-out set (blind)

| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| Exact match (raw address / email) | 100.0% | 8.6% | 15.8% | 0 | 64 | 0.0% | 42.9% | 0 | 0.0s |
| Normalisation + rules (no AI) | 83.3% | 78.6% | 80.9% | 11 | 15 | 73.2% | 100.0% | 0 | 0.3s |
| **Paylet: rules + AI adjudication (MiMo-V2.6-Pro)** — mean of 3 runs | 95.6% ± 0.8 | 83.3% ± 1.6 | **89.1% ± 0.6** | 2.7 ± 0.6 (worst 3) | 11.7 ± 1.2 (worst 13) | 76.8% | 100.0% | 25 | 53.7s |

Paylet, run by run (network/household recall above are from the worst run):

| Run | Precision | Recall | F1 | False merges | Missed links | Pairs kept apart | LLM calls | Degraded |
|---|---|---|---|---|---|---|---|---|
| 1 (worst) | 96.6% | 81.4% | 88.4% | 2 | 13 | 17 | 25 | The AI reviewer could not answer for 2 of 23 groups: 7 uncertain pairs were not reviewed and stay unmerged. Rule-certain clusters are unaffected. |
| 2 | 95.2% | 84.3% | 89.4% | 3 | 11 | 17 | 25 | The AI reviewer could not answer for 1 of 23 groups: 4 uncertain pairs were not reviewed and stay unmerged. Rule-certain clusters are unaffected. |
| 3 | 95.2% | 84.3% | 89.4% | 3 | 11 | 17 | 25 | The AI reviewer could not answer for 1 of 23 groups: 4 uncertain pairs were not reviewed and stay unmerged. Rule-certain clusters are unaffected. |

### Failures on the held-out set

### False merge · 3/3 runs · 3 pairs · cause: rules
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-n11` Valentina Rojas — 8240 NW 52nd Ter, Ste 410 Box 90577, Doral, FL 33166 (human, handwritten; true group `hw-n11`)

What happened: hw-n11 ↔ hw-p2-c linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model. hw-n11 ↔ hw-p2-a linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model.

**Our analysis:** Freight forwarders give every customer the same street and suite and tell them apart by a box/PMB number. Our normaliser keeps only the first unit token ('Ste 410') and drops the box (88213 vs 90577), so a legitimate international fan who uses the same Miami forwarder as a reseller is linked to the reseller with certainty (score 0.9), and rule-certain links never reach the model. In production this is still only a suggestion that the seller must confirm and the fan can appeal, but it is the error we care about most. Planned fix: parse PMB/Box/'#suite-box' as a sub-unit and make 'same suite, different box' uncertain (reviewed by the model) instead of certain. Deliberately not applied before publishing, so the held-out number stays blind.

### Missed link · 3/3 runs · 5 pairs · cause: rules
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)

What happened: Run 1: 5 true pairs missed: 2 were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged; 3 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** Same root cause as the false merge, seen from the other side: '#410-88213' and 'STE 410-88213' normalise to one unit '41088213' instead of suite 410 + box 88213, and '8240 NW 52 Ter' vs '52nd Ter' scores 0.875 on street similarity, just under our 0.88 threshold, so Sofia Mendes's account is never flagged. The model linked 3 of the 4 accounts in runs 2 and 3; in run 1 it returned an empty answer for this group (token budget, see ho-net3), which left only the 2 rule-certain links.

### Missed link · 3/3 runs · 4 pairs · cause: ai_unavailable
  - `ho-net3-4` Sam Tanaka — 1311 Airport Rd, Bldg 1, No. 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-2` Omar T. Nguyen — 1311 Airport Road, Apt 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-3` Tobias Nguyen — 1311 Airport Rd, ParcelHop LLC, Unit 7-B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-0` Ozzie Nguyen — 1311 Airport Rd #7B, Attn: Omar Ngyuen, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-1` NGUYEN, OMAR — 1311 AIRPORT RD STE 7B, SPOKANE WA 99201-4417 — attn: O. N., Spokane, WA 99201 (human, redteam; true group `ho-net3`)

What happened: Run 1: 4 true pairs missed: 4 were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged.

**Our analysis:** Not a judgement error. In all 3 runs MiMo returned an empty answer, twice, for this group of 5. MiMo V2.6 Pro is a reasoning model and its reasoning tokens count against max_tokens: with our 2,000-token cap it spent the whole budget thinking (reproduced with a direct call: finish_reason 'length', 1,999 reasoning tokens, no content; with 8,000 it answers). Paylet failed safe: the pairs stayed unmerged and the run was flagged as degraded. The rules alone linked 4 of the 5 accounts; the fifth ('Bldg 1, No. 7B', where the normaliser takes 'Bldg 1' as the unit) needed the model. Fix: the adjudication budget is now 6,000 tokens (see the after-fix section).

### Missed link · 3/3 runs · 4 pairs · cause: rules
  - `ho-net0-3` lucia ramirez — 1200 harbor blvd, pmb 4b, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-1` Tobias A. Ramirez — 1200 Harbor Blvd Ste 4B, c/o Ramirez Family, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-2` T. Ramirez — 1200 Harbor Boulevard, ShipBridge LLC, Attn: T. Ramirez, No. 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-0` TOBIAS RAMIREZ JR — 1200 HARBOR BLVD, Bldg 1, Ste 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-4` Lucy Tanaka — 1200 Harbor Bvld, STE4B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)

What happened: Run 1: 4 true pairs missed: 4 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** The red-team wrote 'Ste 4B' as 'STE4B' (no space) and misspelled Boulevard as 'Bvld'. Our unit pattern needs a word boundary after 'STE', so the unit becomes 'STE4B', and street similarity drops to 0.875, just under 0.88: that account is never flagged and the model never sees it. The other 4 accounts of this operation were linked in every run (the model read 'Bldg 1, Ste 4-B' and 'No. 4-B' correctly from what was typed), so the operation gets 2 allocations instead of 1, not 5. Planned fix: accept glued unit tokens ('STE4B', 'APT2') and spell-check street suffixes before comparing.

## Held-out set after one fix (not blind)

What changed:
- Adjudication token budget raised from 2,000 to 6,000 (llmAdjudicator in resolve.ts). MiMo is a reasoning model and reasoning tokens count against max_tokens: on two hard groups it spent the whole budget thinking and returned an empty answer (finish_reason "length").
- Nothing else changed: same rules, same prompt, same decision logic, same held-out file. Not blind: we saw the held-out failures before making this change.

Recorded 2026-11-01T02:24:43.540Z with system `968e492b0bd28fc4…`.

| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| Exact match (raw address / email) | 100.0% | 8.6% | 15.8% | 0 | 64 | 0.0% | 42.9% | 0 | 0.0s |
| Normalisation + rules (no AI) | 83.3% | 78.6% | 80.9% | 11 | 15 | 73.2% | 100.0% | 0 | 0.2s |
| **Paylet: rules + AI adjudication (MiMo-V2.6-Pro)** — mean of 3 runs | 95.3% ± 0.2 | 86.2% ± 3.3 | **90.5% ± 1.9** | 3.0 ± 0.0 (worst 3) | 9.7 ± 2.3 (worst 11) | 80.4% | 100.0% | 24 | 87.0s |

Paylet, run by run (network/household recall above are from the worst run):

| Run | Precision | Recall | F1 | False merges | Missed links | Pairs kept apart | LLM calls | Degraded |
|---|---|---|---|---|---|---|---|---|
| 1 (worst) | 95.2% | 84.3% | 89.4% | 3 | 11 | 17 | 24 | The AI reviewer could not answer for 1 of 23 groups: 4 uncertain pairs were not reviewed and stay unmerged. Rule-certain clusters are unaffected. |
| 2 | 95.2% | 84.3% | 89.4% | 3 | 11 | 17 | 24 | The AI reviewer could not answer for 1 of 23 groups: 4 uncertain pairs were not reviewed and stay unmerged. Rule-certain clusters are unaffected. |
| 3 | 95.5% | 90.0% | 92.6% | 3 | 7 | 17 | 23 | — |

### Remaining failures after the fix

### False merge · 3/3 runs · 3 pairs · cause: rules
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-n11` Valentina Rojas — 8240 NW 52nd Ter, Ste 410 Box 90577, Doral, FL 33166 (human, handwritten; true group `hw-n11`)

What happened: hw-n11 ↔ hw-p2-c linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model. hw-n11 ↔ hw-p2-a linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model.

**Our analysis:** Unchanged by the fix: same normaliser root cause as in the blind runs (the forwarder box number is dropped, so a different customer at the same suite is linked with certainty before the model sees it). It now costs 3 pairs in every run instead of 2-3: the model correctly links one more account of the reseller, and the transitive closure pulls the wrongly linked fan into one more pair.

### Missed link · 3/3 runs · 4 pairs · cause: rules
  - `ho-net0-3` lucia ramirez — 1200 harbor blvd, pmb 4b, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-1` Tobias A. Ramirez — 1200 Harbor Blvd Ste 4B, c/o Ramirez Family, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-2` T. Ramirez — 1200 Harbor Boulevard, ShipBridge LLC, Attn: T. Ramirez, No. 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-0` TOBIAS RAMIREZ JR — 1200 HARBOR BLVD, Bldg 1, Ste 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-4` Lucy Tanaka — 1200 Harbor Bvld, STE4B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)

What happened: Run 1: 4 true pairs missed: 4 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** Unchanged by the fix: 'STE4B' (no space) and the 'Bvld' typo keep one account below the review threshold, so the model never sees it; the other 4 accounts are linked in every run.

### Missed link · 3/3 runs · 3 pairs · cause: rules
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)

What happened: Run 1: 3 true pairs missed: 3 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** Unchanged by the fix: same normaliser root cause as in the blind runs (suite and box glued into one unit, and '52 Ter' vs '52nd Ter' just under the street-similarity threshold). With the larger budget the model answered for this group in every run and linked 3 of the 4 accounts.

### Missed link · 2/3 runs · 4 pairs · cause: ai_unavailable
  - `ho-net3-4` Sam Tanaka — 1311 Airport Rd, Bldg 1, No. 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-2` Omar T. Nguyen — 1311 Airport Road, Apt 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-3` Tobias Nguyen — 1311 Airport Rd, ParcelHop LLC, Unit 7-B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-0` Ozzie Nguyen — 1311 Airport Rd #7B, Attn: Omar Ngyuen, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-1` NGUYEN, OMAR — 1311 AIRPORT RD STE 7B, SPOKANE WA 99201-4417 — attn: O. N., Spokane, WA 99201 (human, redteam; true group `ho-net3`)

What happened: Run 1: 4 true pairs missed: 4 were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged.

**Our analysis:** The budget fix was not enough for this group. In 2 of 3 runs MiMo still reasoned past 6,000 tokens on both attempts (calls of 19-35 s) and returned nothing, so these pairs stayed unmerged (fail-safe, flagged as degraded); in run 3 it answered and linked all 5 accounts. Next fix, not applied here: when an answer comes back empty, re-ask for that group in smaller pieces, and cap reasoning effort where the provider supports it.

## Dev set (tuned on it)

| System | Precision | Recall | F1 | False merges | Missed links | Network recall | Household recall | LLM calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| Exact match (raw address / email) | 100.0% | 12.2% | 21.7% | 0 | 108 | 0.0% | 83.3% | 0 | 0.0s |
| Normalisation + rules (no AI) | 90.4% | 100.0% | 95.0% | 13 | 0 | 100.0% | 100.0% | 0 | 0.2s |
| **Paylet: rules + AI adjudication (MiMo-V2.6-Pro)** — mean of 3 runs | 100.0% ± 0.0 | 100.0% ± 0.0 | **100.0% ± 0.0** | 0.0 ± 0.0 (worst 0) | 0.0 ± 0.0 (worst 0) | 100.0% | 100.0% | 17 | 33.6s |

Paylet, run by run (network/household recall above are from the worst run):

| Run | Precision | Recall | F1 | False merges | Missed links | Pairs kept apart | LLM calls | Degraded |
|---|---|---|---|---|---|---|---|---|
| 1 (worst) | 100.0% | 100.0% | 100.0% | 0 | 0 | 13 | 17 | — |
| 2 | 100.0% | 100.0% | 100.0% | 0 | 0 | 13 | 17 | — |
| 3 | 100.0% | 100.0% | 100.0% | 0 | 0 | 13 | 17 | — |

## Examples

### Linked: 5 PayPal accounts, one reseller operation (heldOut, 3/3 runs)
  - `ho-net4-1` Okafor, Jonah Chukwuemeka — 1348 Logistics Parkway, PMB 8B, Tucson, AZ 85701 (agent, redteam; true group `ho-net4`)
  - `ho-net4-2` Jojo Okafor — 1348 Logistics Pkway #8B, Tucson, AZ 85701 (agent, redteam; true group `ho-net4`)
  - `ho-net4-4` Priya R. Walsh — 1348 logistcs pkwy ste 8b, Tucson, AZ 85701 (agent, redteam; true group `ho-net4`)
  - `ho-net4-3` Arjun Okafor — Bldg 1, 1348 Logistics Pkwy, Ste 8B, c/o ShipBridge, Tucson, AZ 85701 (agent, redteam; true group `ho-net4`)
  - `ho-net4-0` Jonah Okafor — 1348 NORTH LOGISTICS PKWY, STE8B, Tucson, AZ 85701 (agent, redteam; true group `ho-net4`)

Linked as one operator (92%): All five are agent entries at one freight-forwarder suite (PMB 8B, c/o ShipBridge) — one reshipper operation.

### Kept apart: Common surname in one building, different apartments (12 vs 21) (heldOut, 3/3 runs)
  - `hw-n2-a` Wei Zhang — 77 Mott St, Apt 12, New York, NY 10013 (human, handwritten; true group `hw-n2-a`)
  - `hw-n2-b` Lin Zhang — 77 Mott Street, #21, New York, NY 10013 (human, handwritten; true group `hw-n2-b`)

Kept apart (85%): Different apartments (12 vs 21) and different mailboxes; shared surname Zhang is too common to merge.

### Failure: False merge (3 pairs) (heldOut, 3/3 runs)
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-n11` Valentina Rojas — 8240 NW 52nd Ter, Ste 410 Box 90577, Doral, FL 33166 (human, handwritten; true group `hw-n11`)

Merged, but they are different people: hw-n11 ↔ hw-p2-c linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model. hw-n11 ↔ hw-p2-a linked by the deterministic rules (score 0.9: same street and unit 410 in 33166); rule-certain links never reach the model.

**Our analysis:** Freight forwarders give every customer the same street and suite and tell them apart by a box/PMB number. Our normaliser keeps only the first unit token ('Ste 410') and drops the box (88213 vs 90577), so a legitimate international fan who uses the same Miami forwarder as a reseller is linked to the reseller with certainty (score 0.9), and rule-certain links never reach the model. In production this is still only a suggestion that the seller must confirm and the fan can appeal, but it is the error we care about most. Planned fix: parse PMB/Box/'#suite-box' as a sub-unit and make 'same suite, different box' uncertain (reviewed by the model) instead of certain. Deliberately not applied before publishing, so the held-out number stays blind.

### Failure: Missed link (5 pairs) (heldOut, 3/3 runs)
  - `hw-p2-c` Andrade Trading LLC — 8240 N.W. 52nd Ter., Suite 410 PMB 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-d` Sofia Mendes — 8240 NW 52 Ter, STE 410-88213, Doral, FL 33166 (human, handwritten; true group `hw-p2`)
  - `hw-p2-b` L. Andrade — 8240 NW 52nd Terrace #410-88213, Doral, FL 33166-4011 (agent, handwritten; true group `hw-p2`)
  - `hw-p2-a` Luis Andrade — 8240 NW 52nd Ter, Ste 410 Box 88213, Doral, FL 33166 (agent, handwritten; true group `hw-p2`)

Left apart, but they are the same household or operation: Run 1: 5 true pairs missed: 2 were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged; 3 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** Same root cause as the false merge, seen from the other side: '#410-88213' and 'STE 410-88213' normalise to one unit '41088213' instead of suite 410 + box 88213, and '8240 NW 52 Ter' vs '52nd Ter' scores 0.875 on street similarity, just under our 0.88 threshold, so Sofia Mendes's account is never flagged. The model linked 3 of the 4 accounts in runs 2 and 3; in run 1 it returned an empty answer for this group (token budget, see ho-net3), which left only the 2 rule-certain links.

### Failure: Missed link (4 pairs) (heldOut, 3/3 runs)
  - `ho-net3-4` Sam Tanaka — 1311 Airport Rd, Bldg 1, No. 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-2` Omar T. Nguyen — 1311 Airport Road, Apt 7B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-3` Tobias Nguyen — 1311 Airport Rd, ParcelHop LLC, Unit 7-B, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-0` Ozzie Nguyen — 1311 Airport Rd #7B, Attn: Omar Ngyuen, Spokane, WA 99201 (human, redteam; true group `ho-net3`)
  - `ho-net3-1` NGUYEN, OMAR — 1311 AIRPORT RD STE 7B, SPOKANE WA 99201-4417 — attn: O. N., Spokane, WA 99201 (human, redteam; true group `ho-net3`)

Left apart, but they are the same household or operation: Run 1: 4 true pairs missed: 4 were in a group the model never answered (empty or truncated answer on both attempts), so they stayed unmerged.

**Our analysis:** Not a judgement error. In all 3 runs MiMo returned an empty answer, twice, for this group of 5. MiMo V2.6 Pro is a reasoning model and its reasoning tokens count against max_tokens: with our 2,000-token cap it spent the whole budget thinking (reproduced with a direct call: finish_reason 'length', 1,999 reasoning tokens, no content; with 8,000 it answers). Paylet failed safe: the pairs stayed unmerged and the run was flagged as degraded. The rules alone linked 4 of the 5 accounts; the fifth ('Bldg 1, No. 7B', where the normaliser takes 'Bldg 1' as the unit) needed the model. Fix: the adjudication budget is now 6,000 tokens (see the after-fix section).

### Failure: Missed link (4 pairs) (heldOut, 3/3 runs)
  - `ho-net0-3` lucia ramirez — 1200 harbor blvd, pmb 4b, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-1` Tobias A. Ramirez — 1200 Harbor Blvd Ste 4B, c/o Ramirez Family, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-2` T. Ramirez — 1200 Harbor Boulevard, ShipBridge LLC, Attn: T. Ramirez, No. 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-0` TOBIAS RAMIREZ JR — 1200 HARBOR BLVD, Bldg 1, Ste 4-B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)
  - `ho-net0-4` Lucy Tanaka — 1200 Harbor Bvld, STE4B, Boise, ID 83702 (agent, redteam; true group `ho-net0`)

Left apart, but they are the same household or operation: Run 1: 4 true pairs missed: 4 were never flagged by the rules (score below the review threshold), so the model never saw them.

**Our analysis:** The red-team wrote 'Ste 4B' as 'STE4B' (no space) and misspelled Boulevard as 'Bvld'. Our unit pattern needs a word boundary after 'STE', so the unit becomes 'STE4B', and street similarity drops to 0.875, just under 0.88: that account is never flagged and the model never sees it. The other 4 accounts of this operation were linked in every run (the model read 'Bldg 1, Ste 4-B' and 'No. 4-B' correctly from what was typed), so the operation gets 2 allocations instead of 1, not 5. Planned fix: accept glued unit tokens ('STE4B', 'APT2') and spell-check street suffixes before comparing.

## Honest caveats

- Both datasets are synthetic and built by us; the generators, the red-team prompts and the hand-written cases are in the repo.
- Rules alone are already strong on recall. The model's job is to remove false merges (a false merge costs a real fan their chance) and to explain decisions, including why it kept look-alikes apart. When the model fails, Paylet errs towards **not** merging.
- When the AI is unavailable, Paylet degrades to rules-only suggestions and says so; nothing is ever auto-merged — the seller confirms every cluster.

Recorded 2026-11-01T02:13:05.361Z (replayed 2026-11-01T02:30:00.731Z) with `primalabs-ai/MiMo-V2.6-Pro`. Reproduce live with `pnpm evals` (needs an OpenAI-compatible key) or offline with `pnpm evals --replay`.
