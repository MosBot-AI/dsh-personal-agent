import type { MediaCapabilities, MediaOutput, MediaSpec } from '@mosbot-ai/dshpa-plugin-api'

/** The first runner admits only explicitly configured, unmetered local providers. */
export function supportsLocalMedia(capabilities: MediaCapabilities, spec: MediaSpec): boolean {
  if (capabilities.mock || capabilities.pricing.kind !== 'free' || capabilities.resources.compute === 'remote') return false
  if (!capabilities.destinations.every(destination => {
    if (destination.kind === 'local') return true
    const url = new URL(destination.origin)
    return ['127.0.0.1', '[::1]'].includes(url.hostname)
  })) return false
  const format = capabilities.formats.find(candidate => candidate.modality === spec.modality)
  return Boolean(format?.operations.includes(spec.operation) && spec.width <= format.maxWidth && spec.height <= format.maxHeight
    && (spec.modality === 'image' || (format.modality === 'video' && spec.durationMs <= format.maxDurationMs)))
}

export function matchesMediaOutput(spec: MediaSpec, output: MediaOutput): boolean {
  if (spec.width !== output.width || spec.height !== output.height || !output.mediaType.startsWith(spec.modality + '/')) return false
  if (spec.modality === 'image') return output.durationMs === undefined
  return output.durationMs !== undefined && Math.abs(spec.durationMs - output.durationMs) <= 100
}
