/**
 * 生成 DSH 插件市场索引（format 1）：node scripts/make-market-index.mjs
 *
 * 为什么要脚本、不手写 JSON：
 *   索引只错一个字段，客户端就只显示「索引无效」，**不告诉你错在哪**。
 *   手写时最容易踩的四处（下面 assertIndex 逐条实现，都是从官方解析器实测出来的）：
 *
 *   1. source.type = "git" 时 commit 必须是 **40 位小写** SHA
 *      写 "b94f5ea" 或大写 → `must be a lowercase 40-hex-digit commit SHA`
 *   2. publishTimestamp 必须是 **整数秒**（毫秒会被拒）
 *      → `must be an integer number of Unix seconds in [0, 10^11)`
 *   3. version 必须是 **精确 SemVer**，不能写 `^0.24.5`
 *      → `must be an exact SemVer version`
 *   4. icon 相对路径**相对索引自身 URL** 解析（不是相对仓库根）
 *      所以索引放在 market/index.json 时，图标要写 `../icon.svg`
 *
 * 以上四条 2026-11-13 用 @deepseek-ai/dsh-plugin-market-index@0.2.1-alpha.4
 * 的 parseMarketIndex 逐个实测过（本脚本不依赖它，离线也能跑，规则镜像在这里）。
 *
 * ⚠️ 索引里指向的 commit **必须已经在远程仓库上**，否则用户点了直接装不上。
 *   本脚本会检查该 commit 是否被 origin/<branch> 覆盖，没覆盖就大声警告
 *   （`--strict` 时直接退出 1）。
 *
 * 用法：
 *   node scripts/make-market-index.mjs                # 用当前 HEAD
 *   node scripts/make-market-index.mjs --commit <sha> # 指定提交（推荐：推送后指向远程实际提交）
 *   node scripts/make-market-index.mjs --strict       # 远程没覆盖该提交就失败退出
 *   node scripts/make-market-index.mjs --print        # 只打印 JSON，不写文件
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpec, validateMarketIndex } from './market-index-rules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'market', 'index.json')
const ICS = join(ROOT, 'market', 'icon.svg')

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const commit = (arg('--commit') || git('rev-parse', 'HEAD')).toLowerCase()
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const strict = process.argv.includes('--strict')
const printOnly = process.argv.includes('--print')

// ── 仓库地址：以 git remote 为准（package.json 的 repository 可能与 fork 不一致）──
function canonicalRepo() {
  let url = ''
  try {
    url = git('remote', 'get-url', 'origin')
  } catch {
    throw new Error('这个仓库没有 origin remote，无法生成 git 源索引')
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) throw new Error(`不认识的 origin 地址：${url}`)
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` }
}

const repo = canonicalRepo()
const repoUrl = repo.url

// ── 索引结构 ──
// icon 相对索引 URL 解析：索引在 market/ 下，图标在仓库根，所以是 ../icon.svg
const iconRef = join('..', 'icon.svg').split('\\').join('/')
const version = pkg.version
const publishTimestamp = Math.floor(Date.now() / 1000)

// 保留历史版本：否则每发一版就把旧版从索引里挤掉，用户再也没法回退
let versions = []
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'))
    versions = prev?.plugins?.[0]?.versions ?? []
  } catch {
    console.warn('  ! 旧索引解析失败，将重新生成（历史版本会丢）')
  }
}
versions = versions.filter(v => v.version !== version)
versions.push({
  version,
  publishTimestamp,
  source: { type: 'git', url: repoUrl, commit },
  engines: { dsh: pkg.engines?.dsh ?? '>=0.2.0-rc.1' },
})

const index = {
  format: 1,
  title: { en: 'Yansunsky DSH plugins', zh: '单树见月 DSH 插件' },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'QQ / OneBot Channel', zh: 'QQ 桥接（OneBot 11）' },
      description: {
        en: 'Bridge QQ private and group chats into DeepSeek Harness over OneBot 11.',
        zh: '把 QQ 私聊与群聊经 OneBot 11 协议接进 DeepSeek Harness：WebSocket 入站、工具出站，支持群唤醒词与兴趣点。',
      },
      icon: iconRef,
      author: String(pkg.author ?? '').replace(/<[^>]*>/, '').trim() || repo.owner,
      homepage: `${repoUrl}#readme`,
      repository: { url: repoUrl },
      keywords: (pkg.keywords ?? []).slice(0, 12),
      versions,
    },
  ],
}

// ── 校验：规则在 market-index-rules.mjs（生成器与测试共用同一份）──
const problems = validateMarketIndex(index)
if (problems.length) {
  console.error('\n索引校验失败：')
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('  ✓ 索引结构校验通过')

// ── 关键前置：索引指向的 commit 必须在远程上，否则用户装不上 ──
function checkRemote() {
  // ⚠️ `merge-base --is-ancestor` 靠**退出码**表达结果：是祖先退出 0、不是退出 1。
  //    所以只能看「有没有抛异常」，不能看 stdout 长度 —— 那是恒真的假绿写法。
  let covered = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    covered = true
  } catch {
    covered = false
  }
  let ahead = '?'
  try {
    ahead = git('rev-list', '--count', `refs/remotes/origin/${branch}..${commit}`)
  } catch {
    ahead = '?'
  }

  if (covered) {
    console.log(`  ✓ commit 已被 origin/${branch} 覆盖`)
    return true
  }
  console.warn(`  ✗ 这个 commit 还不在 origin/${branch} 上（领先 ${ahead} 个提交）`)
  console.warn('    → 用户点安装会失败。先 git push，再重跑本脚本。')
  return false
}

const remoteOk = checkRemote()

// ── 写文件 ──
const json = `${JSON.stringify(index, null, 2)}\n`
if (printOnly) {
  console.log(json)
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  // 用 writeFileSync 写字符串：本仓库 .gitattributes 是 eol=lf，别让 CRLF 混进来
  writeFileSync(OUT, json, 'utf8')
  console.log(`\n已写入 ${relative(ROOT, OUT).split('\\').join('/')}`)
}

// 图标：索引里的 icon 写的是 `../icon.svg`，即**仓库根**的 icon.svg（相对索引 URL 解析）。
// 它本来就在仓库里、也在 package.json 的 files 白名单里，所以这里不需要复制 ——
// 之前那段「拷到 market/」是死代码：加入 iconRef 的 ../ 后目标路径正好回到仓库根，
// existsSync 恒真，分支永远不进（写了个永远不执行的兜底，比没写更误导）。
if (!existsSync(join(ROOT, 'icon.svg'))) {
  console.warn('  ! 仓库根没有 icon.svg，市场里会显示破图')
}

console.log(`\n版本 ${version} · commit ${commit.slice(0, 7)} · ${repoUrl}`)
console.log(`安装 spec：${installSpec(pkg.name, index.plugins[0].versions.find(v => v.version === version))}`)
console.log('\n别人怎么用：插件 → 发现 → 添加索引源，填索引文件的可访问 URL（https）。')
console.log('  GitHub 直出示例：')
const ghPath = relative(ROOT, OUT).split('\\').join('/')
console.log(`  https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${ghPath}`)

if (!remoteOk && strict) process.exit(1)
