// 退出不能被网络连接、Agent 或迟到的异步清理无限阻塞。
export async function cleanupBeforeExit(cleanup, timeoutMs = 5000) {
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(cleanup).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
