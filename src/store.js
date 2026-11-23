import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, chat TEXT NOT NULL, stage TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (task TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task, revision));
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, reply TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, task TEXT NOT NULL UNIQUE, due INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cards (task TEXT PRIMARY KEY, message TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS first_sends (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, card TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_outputs (
      task TEXT NOT NULL, attempt TEXT NOT NULL, text TEXT NOT NULL, truncated INTEGER NOT NULL,
      PRIMARY KEY(task, attempt)
    );
    CREATE TABLE IF NOT EXISTS feishu_delivery_errors (
      task TEXT PRIMARY KEY, operation TEXT NOT NULL, kind TEXT NOT NULL,
      code INTEGER, http_status INTEGER, log_id TEXT, recorded_at INTEGER NOT NULL
    );
  `)
  const decode = row => row && JSON.parse(row.body)
  const get = id => decode(db.prepare('SELECT body FROM tasks WHERE id = ?').get(id))
  const card = id => db.prepare('SELECT message FROM cards WHERE task = ?').get(id)?.message

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function save(task) {
    const persisted = get(task.id)
    const currentRevision = persisted?.revision ?? 0
    if ((task.revision ?? 0) !== currentRevision) throw new Error('任务状态已被其他操作更新，请基于最新状态重试。')
    const latest = db.prepare('SELECT MAX(revision) AS revision FROM history WHERE task = ?').get(task.id)?.revision ?? 0
    const revision = Math.max(currentRevision, latest) + 1
    const recordedAt = Date.now()
    const body = JSON.stringify({ ...task, revision, recordedAt })
    db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage, body=excluded.body`)
      .run(task.id, task.chatId, task.stage, body)
    db.prepare('INSERT INTO history VALUES (?, ?, ?)').run(task.id, revision, body)
    // Keep the identity of an outstanding send across superseding revisions and retries.
    db.prepare(`INSERT INTO outbox (id, task, due) VALUES (?, ?, ?) ON CONFLICT(task) DO NOTHING`)
      .run(randomUUID(), task.id, Date.now())
    // SQL 全部成功后再修改调用方对象，避免事务回滚留下未持久化的修订号。
    task.revision = revision
    task.recordedAt = recordedAt
  }

  function progress(task) {
    task.recordedAt = Date.now()
    const body = JSON.stringify(task)
    db.prepare('UPDATE tasks SET stage = ?, body = ? WHERE id = ?').run(task.stage, body, task.id)
    // 心跳不改变 revision，避免正在展示的卡片操作因刷新而失效。
    db.prepare(`INSERT INTO outbox (id, task, due) VALUES (?, ?, ?)
      ON CONFLICT(task) DO UPDATE SET due = excluded.due`).run(randomUUID(), task.id, Date.now())
  }

  return {
    get, card, save, progress, transaction,
    saveModelOutput(task, attempt, text, truncated) {
      db.prepare(`INSERT INTO model_outputs VALUES (?, ?, ?, ?)
        ON CONFLICT(task, attempt) DO UPDATE SET text = excluded.text, truncated = excluded.truncated`)
        .run(task, attempt, text, Number(truncated))
      db.prepare(`DELETE FROM model_outputs WHERE task = ? AND rowid IN (
        SELECT rowid FROM model_outputs WHERE task = ? ORDER BY rowid DESC LIMIT -1 OFFSET 8
      )`).run(task, task)
    },
    byMessage(message) { return db.prepare('SELECT task FROM cards WHERE message = ?').get(message)?.task },
    inChat(chat) {
      return db.prepare("SELECT body FROM tasks WHERE chat = ? AND stage NOT IN ('accepted','cancelled','delivered','pushed') ORDER BY rowid").all(chat).map(decode)
    },
    inStage(...stages) {
      const params = stages.map(() => '?').join(', ')
      return db.prepare(`SELECT body FROM tasks WHERE stage IN (${params}) ORDER BY rowid`).all(...stages).map(decode)
    },
    once(id, callback) {
      return transaction(() => {
        const previous = db.prepare('SELECT reply FROM events WHERE id = ?').get(id)
        if (previous) return previous.reply
        const reply = callback()
        db.prepare('INSERT INTO events VALUES (?, ?)').run(id, reply)
        return reply
      })
    },
    nextNotice() {
      return db.prepare('SELECT * FROM outbox WHERE due <= ? ORDER BY due, rowid LIMIT 1').get(Date.now())
    },
    firstSend(notice, revision, card) {
      db.prepare('INSERT INTO first_sends VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(notice.id, revision, JSON.stringify(card))
      const snapshot = db.prepare('SELECT revision, card FROM first_sends WHERE id = ?').get(notice.id)
      return { revision: snapshot.revision, card: JSON.parse(snapshot.card) }
    },
    delivered(notice, revision, message) {
      transaction(() => {
        db.prepare('INSERT INTO cards VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET message=excluded.message').run(notice.task, message)
        db.prepare('DELETE FROM first_sends WHERE id = ?').run(notice.id)
        if (get(notice.task)?.revision === revision) db.prepare('DELETE FROM outbox WHERE id = ?').run(notice.id)
        else db.prepare('UPDATE outbox SET due = ?, failures = 0 WHERE id = ?').run(Date.now(), notice.id)
      })
    },
    retryNotice(notice, diagnostic) {
      const delay = Math.min(300_000, 1000 * 2 ** Math.min(notice.failures, 9))
      const now = Date.now()
      transaction(() => {
        const { changes } = db.prepare('UPDATE outbox SET failures = failures + 1, due = ? WHERE id = ?').run(now + delay, notice.id)
        if (!changes) return
        db.prepare(`INSERT INTO feishu_delivery_errors VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task) DO UPDATE SET operation=excluded.operation, kind=excluded.kind, code=excluded.code,
          http_status=excluded.http_status, log_id=excluded.log_id, recorded_at=excluded.recorded_at`)
          .run(notice.task, diagnostic.operation, diagnostic.kind, diagnostic.code ?? null, diagnostic.httpStatus ?? null, diagnostic.logId ?? null, now)
      })
    },
    close() { db.close() },
  }
}
