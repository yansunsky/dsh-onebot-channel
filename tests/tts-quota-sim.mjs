/**
 * tts-quota-sim.mjs —— 每日额度闸 + 对象名单（0.19.0）。
 *
 * 最要紧的两条：
 *   ① **超额度时不许发生网络请求**。额度闸如果放在合成之后，钱已经花掉了，
 *      「拒绝」只是拒了一个已扣费的请求。所以断言「被拒时 fetch 一次都没被调用」。
 *   ② **失败要退款、且钳到 0**。不退 = 失败一次白扣一次；
 *      不钳 = 并发交错时 used 变负数，之后所有请求都被放行。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 隔离 HOME：见 tests/isolated-home.mjs（本机沙箱只有工作区根下的 .tmp-test 能建目录）
const HOME_DIR = useIsolatedHome('tts-quota-')
// 语音产物目录要存在，否则合成成功后写盘会失败
mkdirSync(join(HOME_DIR, '.dsh', 'voice'), { recursive: true })

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

// 假 fetch：数调用次数，返回合法 WAV
let fetchCalls = 0
const requests = []
function makeWav() {
  const data = Buffer.alloc(8, 0)
  const buf = Buffer.alloc(44 + data.length)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + data.length, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(24000, 24)
  buf.writeUInt32LE(48000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(data.length, 40)
  return buf
}
let failNext = false
globalThis.fetch = async (url, init) => {
  fetchCalls += 1
  requests.push({ url: String(url), init })
  if (failNext) {
    return {
      ok: false, status: 500,
      headers: { get: () => 'application/json' },
      text: async () => '{"ok":false,"code":"INTERNAL_ERROR","detail":"boom"}',
      arrayBuffer: async () => new ArrayBuffer(0)
    }
  }
  const bytes = makeWav()
  return {
    ok: true, status: 200,
    headers: { get: () => 'audio/wav' },
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
}

const gate = await import('../lib/tts-gate.js')
const tts = await import('../lib/tts.js')

const TARGET = { kind: 'private', id: '1000000001' }
function baseConfig(extra = {}) {
  return {
    voiceMode: 'free',
    voiceEngine: 'breeze',
    voiceBreezeKey: 'brz_k',
    voiceBreezeVoice: 'voc_v',
    voiceBreezeFormat: 'wav',
    // ⚠️ 2026-11-07 语义反转：空名单从「全放开」改成「谁都不能用」。
    //    所以测试要放行某个目标，就必须**显式把它列进名单** ——
    //    这正是新语义想要的效果（默认谁都别想触发付费合成）。
    voiceTargetsPrivate: [gate.targetKey(TARGET)],
    voiceTargetsGroup: [],
    voiceDailyChars: 20,
    ...extra
  }
}

console.log('\n1. 额度内正常合成：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  const result = await gate.synthesizeForTarget('你好', TARGET, { config: baseConfig() })
  ok(result.ok === true, '合成成功', result.ok === true ? `${result.chars} 字` : result.error)
  ok(fetchCalls === 1, '发生了一次网络请求')
  ok(gate.quotaStatus(baseConfig()).used === 2, '额度扣了 2（两个汉字）')
}

console.log('\n2. 超额度 → 拒绝，且**没有网络请求**（核心断言）：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  // 先把 20 字额度用掉 18
  gate.chargeQuota(18, baseConfig())
  const usedBefore = gate.quotaStatus(baseConfig()).used

  const result = await gate.synthesizeForTarget('这是一段超过额度的很长很长的话', TARGET, { config: baseConfig() })
  ok(result.ok === false, '被拒')
  ok(fetchCalls === 0, '⚠️ 一次网络请求都没发生（钱没花）')
  ok(gate.quotaStatus(baseConfig()).used === usedBefore, '额度没被这次拒绝改动')
  ok(String(result.error).includes('额度'), '错误里说了是额度问题', result.error)
}

console.log('\n3. 失败 → 退款：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  failNext = true
  const result = await gate.synthesizeForTarget('你好', TARGET, { config: baseConfig() })
  ok(result.ok === false, '合成失败')
  ok(gate.quotaStatus(baseConfig()).used === 0, '⚠️ 额度退干净了（失败不花钱）')
  failNext = false
}

console.log('\n3b. 退款必须钳到 0（并发交错时 used 可能变负）：')
{
  gate.resetQuota()
  // 只扣 2，但退 999 —— 不钳的话 used 会变成 -997，
  // 之后**所有请求都会被放行**（因为 used + chars 永远小于上限），额度闸等于失效。
  gate.chargeQuota(2, baseConfig())
  gate.refundQuota(999)
  const used = gate.quotaStatus(baseConfig()).used
  ok(used === 0, '⚠️ 退款后 used 钳在 0，不会是负数', `used=${used}`)
  ok(used >= 0, 'used 非负')

  // 反证：负的 used 会让超额请求被放行。这里用一个**应该被拒**的请求验证没有被放行。
  tts.resetTtsQueue()
  fetchCalls = 0
  const result = await gate.synthesizeForTarget('这是一段很长很长很长很长很长的超出额度的话', TARGET, { config: baseConfig() })
  ok(result.ok === false, '⚠️ 退款钳 0 之后，超额度请求仍然被拒（不是被放行）')
  ok(fetchCalls === 0, '没有网络请求')
}

console.log('\n4. GPT-SoVITS 不计额度：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  const cfg = baseConfig({ voiceEngine: 'gptsovits', voiceGptsovitsUrl: 'http://127.0.0.1:9' })
  // 本机引擎会连不上（端口 9），但我们只关心额度有没有被扣
  await gate.synthesizeForTarget('你好', TARGET, { config: cfg })
  ok(gate.quotaStatus(cfg).used === 0, '本机引擎不占 Breeze 额度')
}

console.log('\n5. 额度 0 = 不限：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  const cfg = baseConfig({ voiceDailyChars: 0 })
  const result = await gate.synthesizeForTarget('很长很长很长很长很长很长很长很长很长的话', TARGET, { config: cfg })
  ok(result.ok === true, '0 时不拦')
  ok(gate.quotaStatus(cfg).unlimited === true, 'unlimited 标记为 true')
}

console.log('\n6. 对象名单：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  // 名单里只有别人
  const cfg = baseConfig({ voiceDailyChars: 0, voiceTargetsPrivate: ['private:999'] })
  const blocked = await gate.synthesizeForTarget('你好', TARGET, { config: cfg })
  ok(blocked.ok === false, '名单外被拒')
  ok(fetchCalls === 0, '也没有网络请求')
  ok(String(blocked.error).includes('没开语音'), '错误说得清是名单问题', blocked.error)

  // 两张名单**互相独立**：私聊名单里有什么，都不影响群名单的判定。
  // ⚠️ 语义反转后这条也要跟着改：不能再断言「群名单空 = 放行」——
  //    空名单现在一律是「谁都不能用」。要验的是「群看到的是自己的那张表」。
  const onlyPrivate = baseConfig({ voiceDailyChars: 0, voiceTargetsPrivate: ['private:999'], voiceTargetsGroup: [] })
  ok(gate.targetAllowed({ kind: 'group', id: '2000000002' }, onlyPrivate).ok === false,
    '只勾了私聊时，群**不会**因为私聊名单被连带放行')

  const onlyGroup = baseConfig({ voiceDailyChars: 0, voiceTargetsPrivate: [], voiceTargetsGroup: ['group:2000000002'] })
  ok(gate.targetAllowed({ kind: 'group', id: '2000000002' }, onlyGroup).ok === true, '勾了群就放行这个群')
  ok(gate.targetAllowed({ kind: 'private', id: '1000000001' }, onlyGroup).ok === false,
    '只勾了群时，私聊**不会**被连带放行（两张表独立）')
}

console.log('\n7. 「禁用」档即使名单放行也拒：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  const cfg = baseConfig({ voiceMode: 'off', voiceDailyChars: 0 })
  const result = await gate.synthesizeForTarget('你好', TARGET, { config: cfg })
  ok(result.ok === false, 'off 档被拒')
  ok(fetchCalls === 0, '没有网络请求')
}

console.log('\n8. 内容审计：念出来的话里有 key → 拒，且不花额度：')
{
  gate.resetQuota()
  tts.resetTtsQueue()
  fetchCalls = 0
  const cfg = baseConfig({ voiceDailyChars: 0 })
  const result = await gate.synthesizeForTarget('the api key is brz_AAAA1111BBBB2222CCCC3333DDDD4444', TARGET, { config: cfg })
  ok(result.ok === false, '被内容审计拦下')
  ok(fetchCalls === 0, '没有网络请求（也没花钱）')
  ok(gate.quotaStatus(cfg).used === 0, '额度没动')
}

console.log('\n9. qq_tts 的 instructions 全链路与目标/额度门控：')
{
  const { getConfig } = await import('../lib/config.js')
  const { registerTtsTool } = await import('../lib/tool.js')
  const cfg = getConfig()
  const before = { ...cfg }
  let tool = null
  Object.assign(cfg, baseConfig({ voiceDailyChars: 2 }), { enabled: true, peerUin: TARGET.id })
  try {
    await registerTtsTool({ tools: { register(spec) { tool = spec } }, effect() {} })
    ok(tool?.name === 'qq_tts', '注册的是实际 qq_tts 工具')
    ok(tool?.parameters.properties.instructions?.type === 'string', 'instructions schema 是 string')
    ok(Array.isArray(tool?.parameters.required) && !tool.parameters.required.includes('instructions'),
      'instructions 是可选参数')
    const rows = [
      ['开启', true, '  温柔地说，末尾带一点笑意  ', '温柔地说，末尾带一点笑意'],
      ['关闭仍传入', false, '这是一段超过正文额度上限、也必须被完全忽略的语气指令', undefined],
      ['遗漏', true, undefined, undefined],
      ['空白', true, ' \n\t ', undefined],
    ]
    for (const [label, enabled, instructions, expected] of rows) {
      gate.resetQuota()
      tts.resetTtsQueue()
      fetchCalls = 0
      requests.length = 0
      cfg.voiceBreezeInstructionsEnabled = enabled
      const result = await tool.execute({ text: '你好', user_id: TARGET.id, instructions })
      ok(result.ok === true && fetchCalls === 1, label + '从工具到 Breeze 恰好合成一次')
      const body = JSON.parse(requests[0]?.init.body || '{}')
      ok(body.text === '你好', label + '不把语气并进朗读正文')
      ok(expected === undefined
        ? !Object.prototype.hasOwnProperty.call(body, 'instructions')
        : body.instructions === expected, label + '的 instructions 穿过目标闸和合成入口后符合开关')
      ok(result.chars === 2 && gate.quotaStatus(cfg).used === 2,
        label + '只按朗读正文扣 2 字，语气指令不改变额度含义')
    }

    gate.resetQuota()
    tts.resetTtsQueue()
    fetchCalls = 0
    cfg.voiceBreezeInstructionsEnabled = true
    cfg.voiceTargetsGroup = ['group:999']
    const blocked = await tool.execute({ text: '你好', user_id: TARGET.id, group_id: '2000000002', instructions: '活泼一点' })
    ok(blocked.ok === false && String(blocked.error).includes('没开语音'), '带 instructions 仍按群优先规则检查目标白名单')
    ok(fetchCalls === 0 && gate.quotaStatus(cfg).used === 0, '未获准目标不请求、不扣费')

    gate.chargeQuota(2, cfg)
    const overQuota = await tool.execute({ text: '你好', user_id: TARGET.id, instructions: '活泼一点' })
    ok(overQuota.ok === false && String(overQuota.error).includes('额度'), '带 instructions 不能绕过每日额度')
    ok(fetchCalls === 0 && gate.quotaStatus(cfg).used === 2, '超额仍不请求且不改变已用额度')
  } finally {
    Object.assign(cfg, before)
    gate.resetQuota()
    tts.resetTtsQueue()
  }
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
