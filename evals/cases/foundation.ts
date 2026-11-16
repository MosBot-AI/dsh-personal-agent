export const journeys = {
  brief: { env: 'DSHPA_INSTALL_LIVE_BRIEF', outputs: 2 },
  research: { env: 'DSHPA_INSTALL_LIVE_RESEARCH', outputs: 1 },
  reminder: { env: 'DSHPA_INSTALL_REMINDER', outputs: 1 },
  review: { env: 'DSHPA_INSTALL_LIVE_REVIEW', outputs: 4 },
  code: { env: 'DSHPA_INSTALL_LIVE_CODE', outputs: 2 },
  organization: { env: 'DSHPA_INSTALL_LIVE_ORGANIZATION', outputs: 1 },
} as const

export type Journey = keyof typeof journeys
export const plan = [1, 2, 3, 4, 5].flatMap(round =>
  (Object.keys(journeys) as Journey[]).map(journey => ({ id: `${journey}-${round}`, journey })))
