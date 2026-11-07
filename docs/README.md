# DSH Personal Agent implementation plan

[简体中文](README-zh.md)

**Status: design and implementation proposal, not a working release.** Updated 2026-11-07 UTC. The repository contained only its existing `LICENSE` when this documentation work began. These documents do not claim that the proposed plugins, APIs, tests, or clients have been implemented.

DSH Personal Agent turns DeepSeek Harness itself into the user's central personal agent: one primary agent coordinates projects, tasks, information, reminders, and delegated work. It is a DSH-native bundle of plugins, not an external assistant that treats DSH as a coding tool. There is no existing-Bot binding, Bot selector, or “use without binding a Bot” product flow.

## Reading order

1. [Product scope and native architecture](01-product-and-architecture.md): responsibilities, plugin boundaries, persistent work, memory, connectors, clients, and voice.
2. [Implementation roadmap](02-implementation-roadmap.md): dependency-ordered milestones, work packages, acceptance gates, and release criteria.
3. [Contracts, security, and tests](03-contracts-security-and-tests.md): proposed data and API contracts, approval, cancellation, recovery, and verification.
4. [Decisions and source audit](04-decisions-and-source-audit.md): confirmed direction, excluded concepts, unresolved Hermes options, pinned upstream evidence, and risks.

English is the primary project documentation language. Each document has a separate `-zh.md` counterpart with the same scope and decision IDs.

## What is settled and what is not

- **Settled product direction:** DSH is the central agent; native plugins first; project/task/information management; an open connector/MCP boundary; persistent conversation and memory as design goals; eventual remote/mobile and voice access.
- **Excluded:** comparison options 6 and 7 concerning existing-Bot binding and a no-binding workaround. Channel account authentication may still be necessary, but it does not select the personal agent.
- **Pending selection:** Hermes comparison options 1–5 and 8–10. Their detailed enhancements are documented as optional proposals, not silently accepted scope.
- **Engineering recommendations:** the concrete package split, SQLite schema, transport shape, milestone scope, and performance gates below. They require implementation validation and do not override pending product decisions.

The first implementation step is a compatibility spike. The inspected current DSH source and the superagent prototype target different DSH versions. Native DSH already has in-process cancellation and assistant streaming; the plan must not mistake SDK surface limitations for missing runtime capabilities.

## Delivery boundaries

This publication adds documentation only. It does not install dependencies, start agents, connect accounts, spend on model calls, change the repository license, create a GitHub Project, or make application changes. Milestone dates and staffing are deliberately not promised. Implementation should advance by acceptance evidence, not by marking a design as delivered.
