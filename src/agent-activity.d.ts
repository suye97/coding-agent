export type AgentActivityKind = 'read' | 'search' | 'edit' | 'command' | 'plan' | 'other'
export type AgentActivityStatus = 'running' | 'completed' | 'error'
export interface AgentActivity {
  id: string
  kind: AgentActivityKind
  status: AgentActivityStatus
  name?: string
  diagnostic?: string
}
export function toolActivityKind(name: unknown): AgentActivityKind
export function normalizeActivity(item: unknown): AgentActivity | undefined
export interface AgentActivitySummary {
  total: number
  counts: Record<AgentActivityKind, number>
  active: AgentActivity[]
  failures: AgentActivity[]
  errors: number
}
export function summarizeActivities(items: unknown): AgentActivitySummary
export function toolFailureDiagnostic(name: unknown, input: unknown, content: unknown, result: unknown, secrets?: string[]): string
