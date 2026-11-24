export interface AgentObservationAssertion {
  id: string
  line: string
  sha256: string
}

export function observationsFromText(id: string, text: string): AgentObservationAssertion[]

export function commandToolObservations(input: {
  id: string
  kind: string
  content: unknown
  result: unknown
}): Promise<AgentObservationAssertion[]>

export function observationsFromFile(id: string, path: string): Promise<AgentObservationAssertion[]>
