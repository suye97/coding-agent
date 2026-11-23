export interface ProjectCheck {
  label: string
  kind?: 'command' | 'operation'
  command: string
  args: string[]
  timeoutMs: number
}

export interface ProjectConfig {
  name: string
  aliases: string[]
  path: string
  baseBranch: string
  remote: string
  checks: ProjectCheck[]
}

export interface PublicConfig {
  enabled: boolean
  appId: string
  userId: string
  dataDirectory: string
  appSecretConfigured: boolean
  tapdCardSource?: { chatId: string; senderId: string; operatorId: string }
  lastGroupCard?: { messageId: string; chatId: string; senderId: string; status: string }
  model: { baseUrl: string; name: string; apiKeyConfigured: boolean }
  projects: ProjectConfig[]
}

export interface ConfigInput {
  enabled: boolean
  appId: string
  userId: string
  dataDirectory: string
  appSecret?: string
  tapdCardSource?: { chatId: string; senderId: string; operatorId: string }
  model: { baseUrl: string; name: string; apiKey?: string }
  projects: ProjectConfig[]
}

export interface TaskSummary {
  id: string
  project: string | null
  stage: string
  revision: number
  summary: string
  recordedAt: number | null
  attempt?: Record<string, unknown>
  deliveryFailures: number
}

export interface TaskDetail {
  requirement: { body: string }
  history: Array<Record<string, unknown>>
  modelOutputs: Record<string, { text: string; truncated: boolean }>
  delivery: Record<string, unknown>
}

export interface DesktopApi {
  getConfig(): Promise<PublicConfig>
  saveConfig(input: ConfigInput): Promise<PublicConfig>
  inspectProject(path: string): Promise<Record<string, unknown>>
  chooseProject(): Promise<string | null>
  listTasks(): Promise<{ status: string; items: TaskSummary[] }>
  getTask(taskId: string): Promise<TaskDetail | null>
  subscribe(listener: () => void): () => void
}

export const channels = {
  configRead: 'config:read',
  configSave: 'config:save',
  projectInspect: 'project:inspect',
  projectChoose: 'project:choose',
  taskList: 'task:list',
  taskDetail: 'task:detail',
  tasksChanged: 'tasks:changed',
} as const
