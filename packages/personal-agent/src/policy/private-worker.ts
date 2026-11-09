import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolsService } from '@deepseek-ai/dsh-tools'
import { installLocalExecutor } from './local-executor.js'

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

/**
 * Trusted coordinator entry point. Bind resume IDs to this work and check
 * model disclosure authority, including any recorded model choice on resume.
 */
export function createPrivateWorkers(
  ctx: Context,
  prepare?: AgentSetup,
  approvedTools?: readonly ToolDefinition[],
): Readonly<PrivateWorkers> {
  function setup(agentCtx: Context, agent: Agent) {
    installLocalExecutor(agentCtx, agent, approvedTools)
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
