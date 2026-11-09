import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

const denial = 'Tools are disabled for private workers'

/** Use the native pipeline with exact host-owned definitions. Never route a managed call through PTC or shell. */
export function installLocalExecutor(ctx: Context, agent: Agent, definitions: readonly ToolDefinition[] = []): void {
  const tools = ctx.get('tools')
  if (!tools) throw new Error('DSH tool registry is unavailable for private workers')
  const approved = new Map(definitions.map(definition => [definition.name, definition]))
  tools.restrict({ allow: [] })
  for (const definition of approved.values()) tools.register(definition)

  const admitted = (call: ToolExecution) => {
    const expected = approved.get(call.name)
    return expected !== undefined && call.agent === agent && call.parent === undefined
      && tools.executable(call.name, agent, call.toolSet) === expected
  }
  tools.guard(call => admitted(call) ? undefined : denial)
  ctx.on('tools/pre-execute', async (call, next) => admitted(call) ? next() : { kind: 'deny', reason: denial }, { prepend: true })
  const pipeline = new ToolExecutionPipeline(ctx, {
    get(name, scope, toolSet) {
      const expected = approved.get(name)
      return expected !== undefined && scope === agent && tools.executable(name, scope, toolSet) === expected ? expected : undefined
    },
    reject: (_name, nested) => nested ? new Error(denial) : undefined,
  })
  tools.setExecutor({
    describe: visible => ({
      schemas: visible.filter(definition => approved.get(definition.name) === definition)
        .map(({ name, description, parameters }) => ({ name, description, parameters })),
    }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
}
