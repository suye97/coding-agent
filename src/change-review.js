const deletionDirective = /^\s*删除文件[：:]\s*(.+?)\s*$/u
const scriptPath = /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|js|mjs|cjs|ts|py|rb|pl|php|vbs|lua|groovy|ya?ml|toml)$/iu
const commandConfig = /(?:^|\/)(?:package\.json|Makefile|GNUmakefile|Jenkinsfile|Dockerfile)(?:\.[^/]*)?$/iu
const suspicious = [
  [/\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:&\s*)?(?:sudo\s+)?(?:bash|sh|zsh|pwsh|powershell|iex|invoke-expression)\b/iu, '将网络响应直接交给解释器执行'],
  [/\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*\s-(?:enc|encodedcommand)\b|\b(?:iex|invoke-expression)\s*\(?[^\n]*(?:frombase64string|invoke-(?:webrequest|restmethod))/iu, '执行编码或远程提供的命令'],
  [/(?:^|[\s;"'`])(?:sudo\s+)?rm\s+(?:-[\w-]+\s+)+["']?(?:\/(?:\*|["'`\s;]|$)|~(?:\/\*|["'`\s;]|$)|\$\{?HOME\}?(?:\/\*|["'`\s;]|$))/imu, '删除命令指向根目录或用户主目录'],
  [/\b(?:git\s+clean\s+-[a-z]*[fx][a-z]*[fx]|git\s+reset\s+--hard|remove-item\b[^\n]*\s-recurse\b[^\n]*(?:\$home\b|[a-z]:[\\/][\s*"']))/iu, '可能清除本地未交付内容'],
]
const maxFindings = 12
const maxPathLength = 180

// Exact, human-authored paths are the only automatic deletion authorization.
function approvedDeletions(requirement) {
  return new Set((requirement ?? '').split(/\r?\n/u)
    .map(line => line.match(deletionDirective)?.[1]).filter(Boolean))
}

// Disabling rename detection preserves the original path in the authorization check.
export async function inspectChanges({ commit, comparisons, requirement, approval, diffEntries, addedLines }) {
  const deletions = new Set()
  const warnings = new Map()
  const approved = approvedDeletions(requirement)
  for (const base of new Set(comparisons)) {
    for (const { kind, path, mode } of await diffEntries(base, commit)) {
      if (kind === 'D' || kind === 'T') deletions.add(path)
      if (kind !== 'D' && !warnings.has(path)) {
        if (mode === '120000') {
          warnings.set(path, '符号链接改动可能改变检查读取或执行的位置')
        } else if (mode === '100755' || scriptPath.test(path) || commandConfig.test(path)) {
          const patch = await addedLines(base, commit, path)
          const hunk = patch.indexOf('\n@@ ')
          if (hunk >= 0) {
            const added = patch.slice(hunk).split('\n').filter(line => line.startsWith('+'))
              .map(line => line.slice(1)).join('\n')
            const match = suspicious.find(([pattern]) => pattern.test(added))
            if (match) warnings.set(path, match[1])
          }
        }
      }
    }
  }
  const findings = [...new Set([...deletions, ...warnings.keys()])]
  if (findings.length > maxFindings || findings.some(path => path.length > maxPathLength || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufffd]/u.test(path))) {
    throw new Error('改动审查超出可安全展示的范围，请缩小提交范围或人工处理。')
  }
  const unapprovedDeletions = [...deletions].filter(path => !approved.has(path))
  return {
    commit,
    deletions: [...deletions],
    unapprovedDeletions,
    warnings: [...warnings].map(([path, reason]) => ({ path, reason })),
    approvalRequired: approval?.commit !== commit && (unapprovedDeletions.length > 0 || warnings.size > 0),
  }
}
