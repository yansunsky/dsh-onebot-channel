/**
 * tts-mutation.mjs —— 对 0.19.0 的关键实现做变异验证。
 *
 * 为什么必须有：本仓库踩过「断言没真正验证被测行为 → 删掉实现照样绿」（坑 27）。
 * 所以每条断言写完都要**把对应实现改坏再跑一遍**，确认它变红。
 *
 * ## 为什么要复制到临时目录
 *
 * 本机沙箱下 `writeFileSync('lib/tts.js')` 是 EPERM（只有 daemon 侧的
 * edit/write 工具能写）。所以变异的方式是：
 *   **把整个插件目录复制一份到临时目录 → 在副本里改 → 在副本里跑测试。**
 * 这样既不改真实工作区，也照样能验证「改坏之后测试会不会红」。
 *
 * ⚠️ 别的坑：
 *   · 每个变异用独立临时目录（坑 30：残留配置会污染下一个变异）
 *   · 子进程输出**重定向到文件再读**（坑 28：stdio:'pipe' 在沙箱里 EPERM，
 *     `error.stdout` 是空的 —— 会表现成「基线就说原始代码是红的」）
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, openSync, closeSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeIsolatedHome } from './isolated-home.mjs'

/**
 * 临时目录的选取 + 创建。
 *
 * ⚠️ 两个坑叠在一起，都实测过：
 *   ① `win_bash` 把 TMPDIR 指到它自己的会话目录，那个位置在沙箱下 mkdtemp 会 EPERM；
 *   ② 即使在可写目录里，**`mkdtemp` 本身也可能被拒**，而 `fs.accessSync(W_OK)`
 *      会误报成「可写」—— 所以不能用 access 判断，只能真的建一次试试。
 * 所以这里用 `mkdirSync` + 随机后缀自己造目录名，逐个候选试。
 */
let TEMP_BASE = null

function makeTempDir(prefix) {
  try {
    // 复用共享的隔离目录逻辑（本机沙箱只有工作区根下的 .tmp-test 能 mkdir，
    // 见 tests/isolated-home.mjs 的注释）
    return makeIsolatedHome(prefix)
  } catch {
    return null
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const lines = []
const both = (text) => { console.log(text); lines.push(text) }

/** 建可写源码副本，依赖通过只读使用的目录连接复用。 */
function makeCopy() {
  const dir = makeTempDir('tts-mut-')
  if (dir === null) return { passed: false, text: '（无法创建临时目录）' }
  for (const sub of ['lib', 'tests', 'locale']) {
    try {
      cpSync(join(ROOT, sub), join(dir, sub), { recursive: true })
    } catch { /* 可选目录 */ }
  }
  copyFileSyncSafe(join(ROOT, 'package.json'), join(dir, 'package.json'))
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction')
  return dir
}

function copyFileSyncSafe(from, to) {
  try { writeFileSync(to, readFileSync(from)) } catch { /* 可选 */ }
}

/** 在副本的隔离 HOME 中跑测试，返回状态与完整输出供断言核对。 */
function runTest(copyDir, testFile) {
  const home = makeTempDir('tts-home-')
  if (home === null) return { passed: false, text: '（无法创建临时 HOME）' }
  mkdirSync(join(home, '.dsh'), { recursive: true })
  const outPath = join(home, 'out.txt')
  try {
    const fd = openSync(outPath, 'w')
    let result
    try {
      result = spawnSync(process.execPath, ['tests/run-isolated.mjs', join('tests', testFile)], {
        cwd: copyDir,
        stdio: ['ignore', fd, fd],
        timeout: 120000
      })
    } finally {
      closeSync(fd)
    }
    return {
      passed: result.status === 0,
      text: readFileSync(outPath, 'utf8') + (result.error ? '\n' + result.error.message : '')
    }
  } finally {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

/** 改副本里的文件、跑测试。原工作区一个字节都不动。 */
function mutate(label, file, search, replace, testFile, expectedFailure) {
  const copyDir = makeCopy()
  try {
    const path = join(copyDir, file)
    const original = readFileSync(path, 'utf8')
    if (!original.includes(search)) {
      both(`  ⚠️ 跳过「${label}」：找不到要改的片段`)
      return { skipped: true }
    }
    if (original.split(search).length !== 2) throw new Error('变异未唯一命中：' + label)
    writeFileSync(path, original.replace(search, replace), 'utf8')
    const result = runTest(copyDir, testFile)
    const caught = !result.passed && (!expectedFailure || result.text.includes('✗ ' + expectedFailure))
    both(`  ${caught ? '✅ 抓住' : '❌ 未抓住'}　${label}`)
    if (!caught) both(result.text.slice(-1500))
    return { ...result, caught }
  } finally {
    try { rmSync(copyDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

both('=== 0.19.0 语音功能变异验证 ===')
both('')

both('基线：原样副本必须全绿')
{
  const copyDir = makeCopy()
  for (const test of ['tts-breeze-sim.mjs', 'tts-queue-sim.mjs', 'tts-quota-sim.mjs', 'sensitive-breeze-sim.mjs', 'voice-fail-sim.mjs', 'voice-autosave-sim.mjs']) {
    const result = runTest(copyDir, test)
    both(`  ${result.passed ? '✅' : '❌'} ${test}`)
    if (!result.passed) {
      both('原始代码就红了 —— 后面的结论全部无效')
      both(result.text)
      process.exit(1)
    }
  }
  try { rmSync(copyDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
both('')

const results = []

both('变异 1：output_format 从 query 挪进 body（会被 422 extra_forbidden 拒）')
results.push(mutate(
  'output_format 挪进 body',
  'lib/tts.js',
  "    + `?output_format=${encodeURIComponent(format)}`",
  '',
  'tts-breeze-sim.mjs'
))
both('')

both('变异 2：队列失败后不吞异常（让整条链变 rejected）')
results.push(mutate(
  '队列失败卡死',
  'lib/tts.js',
  'chain = run.then(() => {}, () => {})',
  'chain = run',
  'tts-queue-sim.mjs'
))
both('')

both('变异 3：队列改成直接执行（并发放开）')
results.push(mutate(
  '队列不串行',
  'lib/tts.js',
  'const run = chain.then(task)',
  'const run = task()',
  'tts-queue-sim.mjs'
))
both('')

both('变异 4：超长文本不本地拦，直接打网络')
results.push(mutate(
  '超长不拦截',
  'lib/tts.js',
  'if (text.length > BREEZE_MAX_CHARS) {',
  'if (false && text.length > BREEZE_MAX_CHARS) {',
  'tts-breeze-sim.mjs'
))
both('')

both('变异 5：把额度闸挪到合成之后（钱先花再拒）')
results.push(mutate(
  '额度闸放错位置',
  'lib/tts-gate.js',
  '  let charged = 0\n  if (chargesQuota(engine)) {\n    const chargedResult = chargeQuota(chars, config)',
  '  let charged = 0\n  if (false && chargesQuota(engine)) {\n    const chargedResult = chargeQuota(chars, config)',
  'tts-quota-sim.mjs'
))
both('')

both('变异 6：失败时不退款（白扣一次）')
results.push(mutate(
  '失败不退款',
  'lib/tts-gate.js',
  '    if (charged > 0) {\n      refundQuota(charged)',
  '    if (false && charged > 0) {\n      refundQuota(charged)',
  'tts-quota-sim.mjs'
))
both('')

both('变异 7：退款不钳到 0（used 可能变负，之后全放行）')
results.push(mutate(
  '退款不钳 0',
  'lib/tts-gate.js',
  "quota.used = Math.max(0, quota.used - Math.max(0, Number(chars) || 0))",
  "quota.used = quota.used - Math.max(0, Number(chars) || 0)",
  'tts-quota-sim.mjs'
))
both('')

both('变异 8：内容审计不拦（key 能被念出去）')
results.push(mutate(
  '内容审计失效',
  'lib/tts.js',
  '  const leak = findLeakInText(trimmed)\n  if (leak !== null) {',
  '  const leak = findLeakInText(trimmed)\n  if (false && leak !== null) {',
  'tts-quota-sim.mjs'
))
both('')

both('变异 9：sensitive.js 去掉 brz_ 形状识别')
results.push(mutate(
  'brz_ 不识别',
  'lib/sensitive.js',
  '  /(?<![A-Za-z0-9])brz_[A-Za-z0-9]{24,}/,',
  '',
  'sensitive-breeze-sim.mjs'
))
both('')

both('变异 10：sensitive.js 去掉「key 单独成词」那条（api key 靠它接住）')
results.push(mutate(
  'key 单独成词不识别',
  'lib/sensitive.js',
  "+ '|(?<![A-Za-z0-9])(?:key|密钥))'",
  "+ ')'",
  'sensitive-breeze-sim.mjs'
))

both('')
both('变异 11：语音失败不兜住（= 2026-11-07「正文发两遍」那个 bug）')
results.push(mutate(
  '语音失败连累整次发送',
  'lib/tool.js',
  '            try {\n              const voiceResult = await sendVoiceToQQ(target, voicePath)',
  '            {\n              const voiceResult = await sendVoiceToQQ(target, voicePath)',
  'voice-fail-sim.mjs'
))

both('')
// 语气链路的变异必须命中指定断言，运行错误不能冒充验证成功。
results.push(mutate('Breeze 丢弃语气字段', 'lib/tts.js',
  'body.instructions = direction', 'void direction', 'tts-breeze-sim.mjs',
  '默认开启只发送有效且获准的简短 instructions'))
results.push(mutate('关闭开关仍发送语气', 'lib/tts.js',
  "config?.voiceBreezeInstructionsEnabled !== false && direction !== ''", "direction !== ''", 'tts-breeze-sim.mjs',
  '关闭仍传入只发送有效且获准的简短 instructions'))
results.push(mutate('工具漏传语气', 'lib/tool.js',
  'synthesizeForTarget(text, target, { instructions: args?.instructions })', 'synthesizeForTarget(text, target)', 'tts-quota-sim.mjs',
  '开启的 instructions 穿过目标闸和合成入口后符合开关'))
results.push(mutate('目标闸漏传语气', 'lib/tts-gate.js',
  'synthesize(text, { config, engine, instructions: options.instructions })', 'synthesize(text, { config, engine })', 'tts-quota-sim.mjs',
  '开启的 instructions 穿过目标闸和合成入口后符合开关'))
results.push(mutate('合成入口漏传语气', 'lib/tts.js',
  'synthesizeBreeze({ text: trimmed, config, instructions: options.instructions })', 'synthesizeBreeze({ text: trimmed, config })', 'tts-quota-sim.mjs',
  '开启的 instructions 穿过目标闸和合成入口后符合开关'))
results.push(mutate('语气不去空白', 'lib/tts.js',
  "typeof instructions === 'string' ? instructions.trim() : ''", "typeof instructions === 'string' ? instructions : ''", 'tts-breeze-sim.mjs',
  '纯空白只发送有效且获准的简短 instructions'))
results.push(mutate('保存失败丢弃语气开关', 'lib/client.js',
  'voiceSaveFailed.current = requestPatch', 'voiceSaveFailed.current = {}', 'voice-autosave-sim.mjs',
  '下一项保存会带上之前失败的关闭操作'))

const caught = results.filter((r) => r.caught === true).length
const leaked = results.filter((r) => r.skipped !== true && !r.caught).length
const skipped = results.filter((r) => r.skipped === true).length
both(`小结：${caught} 个变异被抓住 / ${leaked} 个漏网 / ${skipped} 个跳过`)
if (leaked > 0) both('⚠️ 有漏网 —— 说明对应行为没被真正测到，要补断言')

try {
  writeFileSync(join(ROOT, 'tts-mutation-report.txt'), lines.join('\n'), 'utf8')
} catch { /* 报告写不进去不影响结论 */ }

process.exitCode = leaked === 0 && skipped === 0 ? 0 : 1
