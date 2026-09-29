// v1.248 — ช่องเตือน ops: ห้อง Discord แยก · digest ที่ส่งหาตัวเองไม่นับว่าส่ง · alertOps ที่เดียว
//
// ตรวจพรอด 29 ก.ย. 2569: เตือน ops ในแอปไม่ถึงใครเลย (Lark ว่าง · Discord ทิ้ง 'ops' ·
// digest ส่งหาบัญชี SMTP ตัวเองแต่คืน true) เทสนี้ล็อกสามอย่างที่ทำให้มันถึงคนและพูดความจริง
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// system_heartbeats ในหน่วยความจำ (throttle ของ alertOps)
const rows = new Map<string, { key: string; at: Date; note: string | null }>()
mock.module('../db', {
  namedExports: {
    prisma: {
      systemHeartbeat: {
        findUnique: async ({ where }: any) => rows.get(where.key) ?? null,
        upsert: async ({ where, create, update }: any) => {
          rows.set(where.key, { ...(rows.get(where.key) ?? create), ...update, key: where.key })
        },
      },
    },
  },
})
// เมลปลอม — นับว่ามีการส่งจริงกี่ฉบับ ถึงใคร
const mailed: { to: unknown; subject: string }[] = []
mock.module('../email', {
  namedExports: {
    sendEmail: async (m: any) => { mailed.push({ to: m.to, subject: m.subject }); return {} },
    isEmailConfigured: () => true,
  },
})

let notify: typeof import('../notify')
let ops: typeof import('../ops-alert')
before(async () => {
  notify = await import('../notify')
  ops = await import('../ops-alert')
})

/** env ชั่วคราว คืนค่าหลัง body จบจริง (รวม async) */
async function withEnv<T>(patch: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved: [string, string | undefined][] = Object.keys(patch).map(k => [k, process.env[k]])
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await body()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** webhook ปลอม — เก็บ body ที่ถูก POST เข้ามา */
async function webhook() {
  const got: string[] = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => { got.push(b); res.writeHead(204); res.end() })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/hook`,
    got,
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()) }),
  }
}

// ทุกเทสเริ่มจาก "ไม่มีช่องไหนตั้งไว้" แล้วเปิดเฉพาะที่ต้องการ
const OFF = {
  DISCORD_WEBHOOK_URL: undefined, DISCORD_OPS_WEBHOOK_URL: undefined, DISCORD_NOTIFY_SCOPE: undefined,
  LARK_WEBHOOK_URL: undefined, REMINDER_ADMIN_EMAIL: undefined, EMAIL_FROM: undefined, SMTP_USER: undefined,
}

test('ops ไปห้อง Discord ops แยกเมื่อตั้งไว้ · footage ไม่หลุดเข้าห้อง ops', async () => {
  const hook = await webhook()
  try {
    await withEnv({ ...OFF, DISCORD_OPS_WEBHOOK_URL: hook.url }, async () => {
      assert.equal(await notify.notifyDiscord('worker ตาย', 'ops'), true)
      assert.equal(hook.got.length, 1)
      assert.match(hook.got[0], /worker ตาย/)
      // ห้องทีมไม่ได้ตั้ง → footage ไม่มีที่ไป และต้องไม่ถูกส่งเข้าห้อง ops แทน
      assert.equal(await notify.notifyDiscord('ไฟล์พร้อม', 'footage'), false)
      assert.equal(hook.got.length, 1)
    })
  } finally {
    await hook.close()
  }
})

test('ไม่ตั้งห้อง ops = พฤติกรรมเดิม: ops ไม่เข้าห้องทีม', async () => {
  const team = await webhook()
  try {
    await withEnv({ ...OFF, DISCORD_WEBHOOK_URL: team.url }, async () => {
      assert.equal(await notify.notifyDiscord('worker ตาย', 'ops'), false)
      assert.equal(await notify.notifyDiscord('ไฟล์พร้อม', 'footage'), true)
      assert.equal(team.got.length, 1)
      assert.match(team.got[0], /ไฟล์พร้อม/)
    })
  } finally {
    await team.close()
  }
})

test('digest ที่ผู้รับคือบัญชีที่ใช้ส่ง = ไม่ส่ง และคืน false (ค่าของพรอด 29 ก.ย. 2569)', async () => {
  mailed.length = 0
  await withEnv({ ...OFF, SMTP_USER: 'ops@x.co', REMINDER_ADMIN_EMAIL: 'OPS@x.co ' }, async () => {
    assert.deepEqual(notify.digestRecipients(), [])
    assert.equal(await notify.notifyEmailDigest('s', 't'), false)
  })
  // ไม่มี REMINDER_ADMIN_EMAIL → fallback EMAIL_FROM ซึ่งก็คือผู้ส่ง = ไม่มีใครได้รับเหมือนกัน
  await withEnv({ ...OFF, SMTP_USER: 'ops@x.co', EMAIL_FROM: 'ops@x.co' }, async () => {
    assert.equal(await notify.notifyEmailDigest('s', 't'), false)
  })
  assert.equal(mailed.length, 0, 'ต้องไม่ยิงเมลที่รู้อยู่แล้วว่าไม่มีใครได้รับ')
})

test('digest ถึงกล่องอื่น = ส่งจริงและคืน true · ตัดเฉพาะตัวผู้ส่งออกจากลิสต์', async () => {
  mailed.length = 0
  await withEnv({ ...OFF, SMTP_USER: 'ops@x.co', REMINDER_ADMIN_EMAIL: 'ops@x.co, boss@x.co' }, async () => {
    assert.deepEqual(notify.digestRecipients(), ['boss@x.co'])
    assert.equal(await notify.notifyEmailDigest('s', 't'), true)
  })
  assert.equal(mailed.length, 1)
  assert.deepEqual(mailed[0].to, ['boss@x.co'])
})

test('alertOps: ส่งครั้งแรก · ซ้ำในหน้าต่าง throttle ไม่ส่ง · พ้นหน้าต่างส่งอีก', async () => {
  rows.clear()
  const hook = await webhook()
  try {
    await withEnv({ ...OFF, DISCORD_OPS_WEBHOOK_URL: hook.url }, async () => {
      const first = await ops.alertOps('t-throttle', 'subj', 'ซิงก์ล้ม MIX-001')
      assert.deepEqual(first, { attempted: true, delivered: true, discord: true, lark: false, email: false })
      assert.equal(hook.got.length, 1)
      assert.match(rows.get('alert:t-throttle')!.note!, /discord=true lark=false email=false/)

      const again = await ops.alertOps('t-throttle', 'subj', 'ซิงก์ล้ม MIX-001')
      assert.equal(again.attempted, false)
      assert.equal(hook.got.length, 1, 'อยู่ในหน้าต่าง 6 ชม. ต้องไม่ยิงซ้ำ')

      // key อื่นไม่โดน throttle ของ key นี้
      assert.equal((await ops.alertOps('t-other', 'subj', 'อีกเรื่อง')).delivered, true)

      rows.get('alert:t-throttle')!.at = new Date(Date.now() - ops.OPS_ALERT_EVERY_MS - 1000)
      assert.equal((await ops.alertOps('t-throttle', 'subj', 'ยังล้ม')).attempted, true)
      assert.equal(hook.got.length, 3)
    })
  } finally {
    await hook.close()
  }
})

test('alertOps: ไม่มีช่องไหนถึง = รายงานตามจริง (delivered false) แต่ยังประทับ throttle ไม่วนยิงทุกรอบ', async () => {
  rows.clear()
  await withEnv({ ...OFF, SMTP_USER: 'ops@x.co', REMINDER_ADMIN_EMAIL: 'ops@x.co' }, async () => {
    const r = await ops.alertOps('t-mute', 'subj', 'worker ตาย')
    assert.deepEqual(r, { attempted: true, delivered: false, discord: false, lark: false, email: false })
    assert.ok(rows.get('alert:t-mute'), 'ต้องประทับ — dead-man เรียกทุก 10 นาที ไม่งั้น log ท่วม')
    assert.equal((await ops.alertOps('t-mute', 'subj', 'worker ตาย')).attempted, false)
  })
})
