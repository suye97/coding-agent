export interface AgentModel { name: string; baseUrl: string; apiKey: string }
export interface AgentInput {
  prompt: string
  cwd: string
  stage: 'design' | 'develop' | 'verify'
  electronDist?: string
  resumeSessionId?: string
  model: AgentModel
  signal: AbortSignal
  onOutput(text: string): void
  onActivity?(item: { id: string; kind: 'read' | 'search' | 'edit' | 'command' | 'plan' | 'other'; status: 'running' | 'completed' | 'error' }): void
  onAssertion(item: { id: string; line: string; sha256: string }): boolean | void
  onSession(sessionId: string): void
}
export interface AgentResult { text: string; sessionId: string; stopReason: string }
export function createAgent(options: {
  execute(input: AgentInput): Promise<AgentResult>
  getModel(): Promise<AgentModel>
  loadAttachment?: unknown
  gitCommit?: (cwd: string, signal: AbortSignal) => Promise<string>
  prepareOperation?: (input: { cwd: string; signal: AbortSignal }) => Promise<unknown>
  verificationTimeoutMs?: number
  verificationIdleTimeoutMs?: number
  verificationStepTimeoutMs?: number
  verificationStartupTimeoutMs?: number
}): { design(input: any): Promise<any>; develop(input: any): Promise<any>; verifyOperation(input: any): Promise<any> }
export function normalizeValidation(value: any): any
export function normalizeAlternative(value: any): any
