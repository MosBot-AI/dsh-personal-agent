import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createPrivateWorkers, type PrivateWorkers } from '../policy/private-worker.js'
import { createWorkerExecutor, type WorkerExecutor, type WorkerExecutorOptions } from './executor.js'
import { createRoutedInferenceExecutor, type RoutedInferenceExecutor } from './routed-inference.js'
import { createNativeWorkerRuntime, type NativeWorkerRuntime } from './native-worker.js'

export interface HostAdapter {
  readonly agents: Readonly<Pick<AgentRegistry, 'create' | 'resume'>>
  readonly privateWorkers: Readonly<PrivateWorkers>
  readonly workerRuntime: NativeWorkerRuntime
  createWorkerExecutor(options: Omit<WorkerExecutorOptions, 'runtime'>): WorkerExecutor
  createInferenceExecutor(options: Omit<Parameters<typeof createRoutedInferenceExecutor>[1], 'flush'>): RoutedInferenceExecutor
  flush(session: Session): Promise<void>
}

export function createHostAdapter(ctx: Context): HostAdapter {
  const agents = Object.freeze<HostAdapter['agents']>({
    // Access the registry through the bundle context so Cordis owns the handles.
    create: options => ctx.agents.create(options),
    resume: options => ctx.agents.resume(options),
  })
  async function flush(session: Session) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('DSH session service is unavailable')
    if (!await sessions.flush(session)) {
      throw new Error('DSH session flush has no durability listener')
    }
  }
  const workerRuntime = createNativeWorkerRuntime(ctx, flush)
  return Object.freeze<HostAdapter>({
    agents,
    privateWorkers: createPrivateWorkers(ctx),
    workerRuntime,
    createWorkerExecutor: options => createWorkerExecutor({ ...options, runtime: workerRuntime }),
    createInferenceExecutor: options => createRoutedInferenceExecutor(ctx, { ...options, flush }),
    flush,
  })
}
