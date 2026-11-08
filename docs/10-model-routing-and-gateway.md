# 10. Configurable model routing and API gateway

[Documentation index](README.md) · [简体中文](10-model-routing-and-gateway-zh.md)

Researched 2026-11-07. Earlier O1 only selected models explicitly. Difficulty-based model/effort selection and user-defined primary/fallback pools are now required for desktop alpha. This is a design, not an installed gateway or tested model integration.

## 1. Implementations and selection

| Implementation | Verified surface | Use and limits |
| --- | --- | --- |
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) / [reliability](https://docs.litellm.ai/docs/router/learn/reliability) | Deployment routing, retries, fallback and cooldown with usage controls | Preferred optional self-hosted gateway adapter; not task understanding or core authority/budget ownership |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | Strong/weak routing with workload-calibrated thresholds | Optional future DifficultyEstimator; two-model focus does not solve quotas or effort; some routers require extra embedding calls |
| [Portkey](https://portkey.ai/docs/product/ai-gateway/fallbacks) | Ordered/status-triggered fallback and chain tracing | Alternative external adapter; recheck OSS/self-hosted/hosted feature boundaries at version pinning; no mandatory hosted dependency |

Choose a **native routing plugin, default DSH direct execution, and optional LiteLLM gateway adapter**. Reuse gateway transport/reliability rather than building another proxy platform or delegating task ownership to a gateway. This is an architectural recommendation, not a performance benchmark. Pin versions, licenses, dependencies and contracts before adoption.

## 2. Plugin responsibilities

Add `model-routing` and `model-gateway-litellm`; extend plugin-api with ModelRoutingPolicy, DifficultyEstimator and ModelGatewayProvider. Deterministic scoring needs no additional service. Optional semantic scoring has its own budget and falls back to rules without recursively routing itself.

```text
Task / phase / user override
 → data and capability filters → difficulty → model and effort
 → core atomic budget reservation → DSH request assembly → direct or gateway
 → usage/health/outcome reconciliation → finish, escalate, fall back or wait
```

The primary Router coordinates work; model-routing governs inference. Core services retain authority, budgets, state and effect deduplication.

## 3. User configuration

Configure deployments with label, provider/model ID, endpoint, CredentialRef, capabilities, supported effort, context/output limits, pricing/unknown price, account/quota bucket, rate limits and allowed data. Separate accounts are separate deployments; models sharing an account may share quota.

Provide fast/balanced/deep pools, ordered backups and terminal fallbacks; automatic/fixed modes, per-task overrides, effort preferences, escalation rules, switch limits and daily/task monetary/token limits. A dry-run view explains selection, exclusions and estimates without sending actual context.

Proposed dshpa policy, not native LiteLLM configuration; aliases must resolve to verified deployments:

```yaml
mode: automatic
pools:
  fast: [quick-a, quick-b]
  balanced: [general-a]
  deep: [reasoner-a, reasoner-b]
rules:
  simple: {pool: fast, effort: low}
  standard: {pool: balanced, effort: medium}
  complex: {pool: deep, effort: high}
fallbacks:
  rate_limit: [same-capability-backup]
  quota_exhausted: [alternate-account-model, local-model]
  unavailable: [same-capability-backup, local-model]
terminalFallbacks: [local-model]
onExhausted: wait
maxSwitchesPerTask: 2
```

Logical effort tiers map explicitly to each deployment's supported values or thinking budget. Unsupported reasoning is omitted or the model excluded under user policy. Output limits are not effort. No candidate means no automatic account creation, top-up or unauthorized model use.

## 4. Difficulty selection

Filter tools/schema/vision/context support, destinations, budgets and account health first. Score task type, constraints, dependencies, evidence volume, modalities, code scope, verification difficulty, failures and latency needs. Length alone is insufficient; action risk differs from reasoning complexity.

Initial mappings: extraction/formatting → fast/low; multi-source summary or ordinary code change → balanced/medium; difficult planning, cross-module repairs or conflicting evidence → deep/high. Users supply actual models and mappings; marketing names do not prove capability. Deterministic status commands do not use an LLM.

Low confidence uses a configured conservative tier or asks about material ambiguity. Verification failures allow bounded effort/model escalation; missing permissions/data require waiting. Reassess at task/phase boundaries and meaningful failure, not every token. Fixed mode does not auto-upgrade by default. Acceptance criteria remain unchanged after fallback.

PA-041 implements deterministic difficulty and configured pool and effort rules. Optional semantic estimation passes through the separate Core budget port, and quality escalation retains the acceptance digest. [Verification evidence](evidence/PA-041.md)

## 5. Quotas and exhaustion

| Condition | Response |
| --- | --- |
| Temporary RPM/TPM | Retry-After/cooldown or permitted backup, not permanent exhaustion |
| Credit/subscription/token quota exhausted | Disable affected account/bucket until trusted reset/repair; use quota chain |
| dshpa hard spending cap | No new paid calls; permitted local/zero-incremental-cost candidates must still satisfy resource limits, else wait |
| Context overflow | Controlled compaction or larger compatible context |
| Timeout/5xx/network | Bounded retry/circuit breaker; retain uncertain spend reservation |
| Bad key/permission/unsupported parameter | Mark deployment for repair; only independently authorized compatible alternatives may take over |
| Safety/authorization denial | Retain denial; do not route around it |
| All candidates unavailable | Persist waiting_resource with nextCheckAt and condition, release slot and notify once |

Quota telemetry distinguishes local measurements, provider reports, estimates and unknowns, with timestamp/resetAt/confidence. Unknown is not unlimited. API billing and chat subscription allowances may be separate or inaccessible; do not assume subscription access. Use trusted resets or bounded probes, not model polling.

Recheck capabilities, effort, destinations and budgets on every fallback. Configured grants need no repeated confirmation, but new destinations or exceeded caps cannot proceed. Assign one global fallback owner and bound gateway retries within the same attempt budget; reject cycles and do not evade service limits by account rotation.

PA-042 implements shared quota admission, atomic Core claims and durable waits around fresh inference Sessions. [Verification evidence](evidence/PA-042.md)

## 6. DSH and persistence

Pinned [LlmCallConfig](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/call-config.ts) carries reasoningEffort; [model resolution](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/index.ts) validates support. The host snapshots selection before a step and retains it on retry; the old agent/request hook cannot freely change it. [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md).

PA-040 verifies the request boundary on published DSH 0.2.2-rc.1 using the existing selection and request-series APIs. [Verification evidence](evidence/PA-040.md)

Rerouting creates a new inference attempt/request series, not a replay of the business task. Reassemble for the new model's capabilities; never transfer incompatible hidden reasoning or encrypted state. A gateway hiding the actual deployment cannot perform cross-model fallback unless capability equivalence is established.

Mark partial streams interrupted and start a separate attempt, never splice models' output. Dispatch only complete validated tool calls; preserve completed effects. A timed-out inference may still be billed.

Persist ModelDeployment, QuotaBucket, RoutingPolicyRevision, RoutingDecision and InferenceAttempt, including exclusions, difficulty/confidence, actual model/effort, fallback cause, usage, pricing and reservation references. Exclude secrets/private reasoning. Configuration updates affect new decisions; revocation blocks new dispatch immediately.

## 7. Delivery and evaluation

PA-040 covers contracts/host probing, PA-041 difficulty/effort, PA-042 quotas/fallback and PA-043 gateway/UI/evaluation. All are required in desktop alpha; M1 first establishes a fixed-model reliable baseline.

E22 tests difficulty, unsupported effort, fixed overrides and quality escalation. E23 tests shared quotas, temporary limits, total exhaustion, local fallback, budget races, interrupted streams, restart and no repeated tools. E24 tests configuration, dry runs, gateway failure, visibility and retry bounds.

Evaluate ≥60 Chinese/English tasks against fixed strong and fixed economical baselines, reporting success, cost, latency, misrouting and escalations. Initial gate: success no more than five percentage points below the strong baseline and lower measured cost, with no relaxation of security/privacy. Otherwise retain manual mode and improve scoring. Verify at least two authorized live models and one fallback; mocks do not prove real quota visibility.
