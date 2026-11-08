# DSHPA native model-routing boundary

[简体中文](README-zh.md)

This package prepares one approved inference attempt for DSH 0.2.2-rc.1. The [routing contracts](../plugin-api/src/model-routing.ts) describe deployments, account and quota identity, versioned policy, route decisions and inference attempts.

`prepareDshRouting(ctx, plan, core, signal)` validates the plan and resolves the exact model's native reasoning metadata. A successful result contains the native Session ID, Agent options and unpublished Agent setup. Pass all three to `ctx.agents.create` before sending approved input. The coordinator owns the input, context disclosure, scoped tools, and Agent lifecycle.

```ts
const prepared = await prepareDshRouting(ctx, plan, core, signal)
if (prepared.ok) {
  const handle = await ctx.agents.create({ ...prepared.options, signal })
  // The coordinator owns handle disposal and authorized input.
}
```

`core.isCurrent` checks the task fence, policy and deployment revisions, and the real account, quota and provider binding. `core.dispatch` owns budget admission, claiming and settlement for each native request, including retries. The adapter fences the native stream to the pinned provider, model, effective effort and output limit and rechecks authority before the underlying stream starts.

A reroute uses a new inference attempt and request-series ID while retaining the business Task identity. Build the new input from authorized evidence. The fresh Session has its own request header and no inherited transcript or adapter replay state. The coordinator retains confirmed effects and unresolved spend reservations across attempts.

DSH supports native reasoning effort IDs and verified adapter defaults. The contract also records thinking-budget mappings for transports that support them. The native adapter rejects those mappings at preparation because its DSH request contract exposes a reasoning effort ID. Quota-driven fallback and durable attempt reconciliation are tracked in PA-042. [Routing design](../../docs/10-model-routing-and-gateway.md)

## Select a route by task difficulty

Call `decideRouting` from `@mosbot-ai/dshpa-model-routing/policy` with the approved Task fence, its acceptance digest, structured task and phase signals, the current policy revision, and exact deployment revisions. The Core inspection callback checks the live destination, account, quota and budget before the policy scores the task.

Automatic policy maps simple, standard and complex work to configurable pool and effort rules. The defaults are fast with low effort, balanced with medium effort, and deep with high effort. Low-confidence results use at least the configured conservative tier. Set `unsupportedEffort` to `omit` to allow an automatic route to use a verified adapter default when its requested effort mapping is unavailable. A fixed route or explicit owner override uses its exact approved choice.

A semantic estimator is optional. Its policy declares separate input, output, spend and time ceilings. Core claims that budget and deduplicates the Task and phase key before the estimator receives structured signals. The policy rechecks live admission after the estimate. Verified quality failures may select a higher configured tier while retaining the same Task fence and acceptance digest. A same-deployment escalation requires an increase in the provider's declared effort order. Core records and bounds the switch count.

Pass an admitted routing decision to the native inference preparation above. The coordinator owns the authoritative policy, verification receipts and budget state.
