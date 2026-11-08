import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

const DENIAL = 'Tools are disabled for private workers'

export interface PrivateWorkerCreateOptions extends Pick<CreateAgentOptions, 'sessionId' | 'agentOptions' | 'signal'> {
  readonly meta?: Pick<NonNullable<CreateAgentOptions['meta']>, 'cwd'>
}

export type PrivateWorkerResumeOptions = Pick<ResumeAgentOptions, 'resumeSessionId' | 'agentOptions' | 'signal'>

export interface PrivateWorkers {
  create(options: PrivateWorkerCreateOptions): Promise<AgentHandle>
  resume(options: PrivateWorkerResumeOptions): Promise<AgentHandle>
}

function requireTools(ctx: Context): ToolsService {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('DSH tool registry is unavailable for private workers')
  return tools
}

function modelOptions(options: AgentOptions | undefined): AgentOptions | undefined {
  if (options === undefined) return undefined
  const { provider, model, reasoningEffort, maxTokens } = options
  return { provider, model, reasoningEffort, maxTokens }
}

function installPrivatePolicy(ctx: Context): void {
  const tools = requireTools(ctx)
  tools.restrict({ allow: [] })
  tools.guard(() => DENIAL)
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: DENIAL }), { prepend: true })

  // The native batch still settles and journals model calls. Never resolve
  // registered definitions or a preset executor's reserved code transport.
  const pipeline = new ToolExecutionPipeline(ctx, { get: () => undefined })
  tools.setExecutor({
    describe: () => ({ schemas: [] }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  })
}

/**
 * Trusted coordinator entry point. Bind resume IDs to this work and check
 * model disclosure authority, including any recorded model choice on resume.
 */
export function createPrivateWorkers(
  ctx: Context,
  prepare?: AgentSetup,
): Readonly<PrivateWorkers> {
  function setup(agentCtx: Context, agent: Agent) {
    installPrivatePolicy(agentCtx)
    return prepare?.(agentCtx, agent)
  }
  return Object.freeze<PrivateWorkers>({
    async create({ sessionId, agentOptions, signal, meta }) {
      requireTools(ctx)
      return ctx.agents.create({
        sessionId,
        agentOptions: modelOptions(agentOptions),
        signal,
        meta: meta?.cwd === undefined ? undefined : { cwd: meta.cwd },
        setup,
      })
    },
    async resume({ resumeSessionId, agentOptions, signal }) {
      requireTools(ctx)
      return ctx.agents.resume({
        resumeSessionId,
        agentOptions: modelOptions(agentOptions),
        signal,
        setup,
      })
    },
  })
}
