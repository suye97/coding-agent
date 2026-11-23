import { spawn } from 'node:child_process'
import electron from 'electron'

const children = []
const launch = (command, args, env = {}) => {
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  children.push(child)
  return child
}
const vite = launch(process.execPath, ['node_modules/vite/bin/vite.js'])
vite.once('exit', code => { if (code) process.exitCode = code })
const timer = setTimeout(() => {
  const desktop = launch(electron, ['.'], { VITE_DEV_SERVER_URL: 'http://localhost:5173' })
  desktop.once('exit', () => { for (const child of children) child.kill(); process.exit() })
}, 1200)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearTimeout(timer)
  for (const child of children) child.kill()
  process.exit()
})
