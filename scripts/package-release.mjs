import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import asar from '@electron/asar'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：npm run package:release -- [版本号]')
  console.log('省略版本号时使用 package.json 中的当前版本。')
  process.exit(0)
}
if (args.length > 1 || (args[0] && !/^\d+\.\d+\.\d+$/u.test(args[0]))) {
  throw new Error('版本号必须使用 x.y.z 格式，例如：npm run package:release -- 0.2.9')
}
if (process.platform !== 'win32') throw new Error('此脚本生成 Windows NSIS 安装包，请在 Windows 上运行。')

const root = fileURLToPath(new URL('../', import.meta.url))
const packagePath = join(root, 'package.json')
const packageJson = () => readFile(packagePath, 'utf8').then(JSON.parse)
const current = await packageJson()
const version = args[0] ?? current.version
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('请通过 npm run package:release 运行此脚本。')

const run = async command => {
  await new Promise((resolve, reject) => {
    // Node 26 on Windows rejects spawning npm.cmd directly with EINVAL.
    // Invoke the same npm CLI JavaScript with the current Node executable.
    const child = spawn(process.execPath, [npmCli, ...command], { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`命令失败：npm ${command.join(' ')}（${signal ?? `退出码 ${code}`}）`))
    })
  })
}

await run(['test'])
if (version !== current.version) await run(['version', version, '--no-git-tag-version'])
await run(['run', 'dist'])

const { productName } = await packageJson()
const installer = join(root, 'release', `${productName} Setup ${version}.exe`)
const archive = join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
await Promise.all([access(installer), access(archive)])
asar.uncache(archive)
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
if (packaged.version !== version) throw new Error(`包内版本 ${packaged.version} 与目标版本 ${version} 不一致。`)

const bytes = await readFile(installer)
const { size } = await stat(installer)
console.log(`\n安装包：${installer}`)
console.log(`大小：${(size / 1024 / 1024).toFixed(2)} MiB`)
console.log(`SHA-256：${createHash('sha256').update(bytes).digest('hex')}`)
