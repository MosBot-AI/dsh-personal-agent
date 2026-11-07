import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { nonEmptyTextSchema } from '../domain/model.js'

export const workerPresetSchema = z.strictObject({
  id: nonEmptyTextSchema.max(256),
  rootDirectory: nonEmptyTextSchema.refine(path => isAbsolute(path) && !path.includes('\0'), 'Expected an absolute worker root directory'),
  provider: nonEmptyTextSchema.max(256),
  model: nonEmptyTextSchema.max(256),
  dataScope: z.array(nonEmptyTextSchema.max(256)).max(64).refine(labels => new Set(labels).size === labels.length),
})

export type WorkerPreset = z.infer<typeof workerPresetSchema>

/** Resolve the existing directory before passing it to the native worker. */
export function resolveWorkerDirectory(rootDirectory: string, cwd: string): string | undefined {
  if (!isAbsolute(rootDirectory) || cwd.trim().length === 0) return undefined
  try {
    const root = realpathSync(rootDirectory)
    const directory = realpathSync(resolve(rootDirectory, cwd))
    const pathFromRoot = relative(root, directory)
    if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) return undefined
    return statSync(directory).isDirectory() ? directory : undefined
  } catch {
    return undefined
  }
}

/** Provider/model binding does not expand the preset's allowed disclosure labels. */
export function allowsWorkerData(preset: WorkerPreset, labels: readonly string[]): boolean {
  return labels.every(label => preset.dataScope.includes(label))
}
