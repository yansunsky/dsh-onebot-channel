/**
 * 插件市场索引自检：node tests/market-index-sim.mjs，退出码 0 = 全过。
 *
 * 为什么要这组测试：
 *   索引错一个字段，DSH 客户端只显示「索引无效」，**不告诉你错在哪**。
 *   而索引是「发出去就摆在用户面前」的东西 —— 错了别人的「发现」页就是空的。
 *   所以把 40 位 SHA、整数秒、精确 SemVer 这些坑逐条钉住。
 *
 * 规则本身在 scripts/market-index-rules.mjs（生成器与这里共用同一份）。
 * 这个测试同时做两件事：
 *   ① 逐条验证规则会拒绝已知的错误写法（反向用例，防「校验形同虚设」）
 *   ② 验证仓库里真的那份 market/index.json 是合规的（正向用例）
 *
 * ⚠️ 这里**不** import 官方解析器：它是 alpha、安装要联网几十秒，
 *   离线环境跑不了。想用官方包复核一次（比如升 DSH 大版本后），在
 *   .pwsh-tmp/mktcheck 那样的临时目录里装好后跑：
 *
 *     node -e "import('@deepseek-ai/dsh-plugin-market-index').then(m=>{
 *       const d=JSON.parse(require('fs').readFileSync('market/index.json','utf8'));
 *       m.parseMarketIndex(d,'https://example.com/index.json');
 *       console.log('官方校验通过')})"
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpec, validateMarketIndex } from '../scripts/market-index-rules.mjs'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(SRC, 'market', 'index.json')

/** 造一份最小合规索引，供反向用例改坏一处用。 */
function baseline() {
  return {
    format: 1,
    plugins: [
      {
        name: 'dsh-example',
        versions: [
          {
            version: '1.2.3',
            publishTimestamp: 1790476800,
            source: {
              type: 'git',
              url: 'https://github.com/example/dsh-example',
              commit: 'a'.repeat(40),
            },
          },
        ],
      },
    ],
  }
}

console.log('基线：合法索引应当通过')
{
  ok(validateMarketIndex(baseline()).length === 0, '最小合规索引无问题')

  const npmSrc = baseline()
  npmSrc.plugins[0].versions[0].source = { type: 'npm' }
  ok(validateMarketIndex(npmSrc).length === 0, 'npm 源（无 registry）也合规')
}

console.log('\n反向用例：每一处已知错法都必须被抓出来')
{
  // 实测：官方报 `must be a lowercase 40-hex-digit commit SHA`
  for (const [label, commit] of [
    ['短 SHA（7 位）', 'a'.repeat(7)],
    ['大写 SHA', 'A'.repeat(40)],
    ['39 位', 'a'.repeat(39)],
    ['41 位', 'a'.repeat(41)],
    ['空串', ''],
  ]) {
    const d = baseline()
    d.plugins[0].versions[0].source.commit = commit
    const p = validateMarketIndex(d)
    ok(p.length > 0 && p.some(x => x.includes('40 位小写')), `拒绝 ${label}`)
  }

  // 实测：官方报 `must be an integer number of Unix seconds in [0, 10^11)`
  for (const [label, ts] of [
    ['毫秒时间戳', Date.now()],
    ['小数秒', 1790476800.5],
    ['负数', -1],
    ['字符串', '1790476800'],
  ]) {
    const d = baseline()
    d.plugins[0].versions[0].publishTimestamp = ts
    const p = validateMarketIndex(d)
    ok(p.length > 0 && p.some(x => x.includes('整数秒')), `拒绝 ${label}`)
  }

  // 实测：官方报 `must be an exact SemVer version`
  for (const [label, ver] of [
    ['带 ^ 的范围', '^1.2.3'],
    ['带 ~ 的范围', '~1.2.3'],
    ['只有两段', '1.2'],
    ['latest 标签', 'latest'],
  ]) {
    const d = baseline()
    d.plugins[0].versions[0].version = ver
    const p = validateMarketIndex(d)
    ok(p.length > 0 && p.some(x => x.includes('精确 SemVer')), `拒绝版本号 ${label}`)
  }

  // 仓库地址：不能是 tarball、不能带结尾斜杠、不能是 http
  for (const [label, url, keyword] of [
    ['tarball 地址', 'https://github.com/example/dsh-example.tgz', 'tarball'],
    ['.tar.gz 地址', 'https://github.com/example/dsh-example.tar.gz', 'tarball'],
    ['结尾斜杠', 'https://github.com/example/dsh-example/', 'https 仓库地址'],
    ['只有一段路径', 'https://github.com/onlyone', 'https 仓库地址'],
    ['http 明文', 'http://github.com/example/dsh-example', 'https 仓库地址'],
  ]) {
    const d = baseline()
    d.plugins[0].versions[0].source.url = url
    const p = validateMarketIndex(d)
    ok(p.length > 0 && p.some(x => x.includes(keyword)), `拒绝 url：${label}`)
  }

  // 结构级错误
  ok(validateMarketIndex(null).length > 0, '拒绝 null')
  ok(validateMarketIndex({ format: 2, plugins: [] }).length > 0, '拒绝 format != 1')
  ok(validateMarketIndex({ format: 1, plugins: [] }).length > 0, '拒绝空 plugins')

  const badName = baseline()
  badName.plugins[0].name = 'Dsh-Example'
  ok(validateMarketIndex(badName).some(x => x.includes('合法 npm 包名')), '拒绝大写包名')

  const badType = baseline()
  badType.plugins[0].versions[0].source = { type: 'tarball', url: 'https://x/y/z' }
  ok(validateMarketIndex(badType).some(x => x.includes('只能是')), '拒绝未知 source.type')

  const badPath = baseline()
  badPath.plugins[0].versions[0].source.path = '../escape'
  ok(validateMarketIndex(badPath).some(x => x.includes('source.path')), '拒绝 ../ 逃逸的 path')
}

console.log('\ninstallSpec：与实际 pnpm spec 对齐')
{
  const git = baseline().plugins[0].versions[0]
  ok(
    installSpec('dsh-example', git) === `git+https://github.com/example/dsh-example.git#${'a'.repeat(40)}`,
    'git 源生成 commit-pinned spec',
  )

  const withPath = { ...git, source: { ...git.source, path: 'packages/foo' } }
  ok(installSpec('dsh-example', withPath).includes('&path:packages/foo'), 'monorepo path 带 &path:')

  const npm = { version: '1.2.3', source: { type: 'npm' } }
  ok(installSpec('dsh-example', npm) === 'dsh-example@1.2.3', 'npm 源生成 name@version spec')
}

console.log('\n仓库里真实的 market/index.json')
{
  ok(existsSync(INDEX), 'market/index.json 存在')

  if (existsSync(INDEX)) {
    const raw = readFileSync(INDEX, 'utf8')
    let doc
    try {
      doc = JSON.parse(raw)
      ok(true, '是合法 JSON')
    } catch (error) {
      ok(false, `是合法 JSON（${error.message}）`)
    }

    if (doc) {
      const problems = validateMarketIndex(doc)
      ok(problems.length === 0, `通过规则校验${problems.length ? `：${problems.join('；')}` : ''}`)

      const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
      const plugin = doc.plugins[0]

      // 索引必须描述**本仓库这个包**，不是别人的
      ok(plugin.name === pkg.name, `name 与 package.json 一致（${plugin.name}）`)

      // 最新版本必须跟 package.json 同步，否则用户装到的是旧版
      const newest = plugin.versions[0]
      ok(newest.version === pkg.version, `最新版本与 package.json 一致（${newest.version}）`)

      // 版本按 SemVer 降序（客户端取第一个当推荐版本）
      const versions = plugin.versions.map(v => v.version)
      const sorted = [...versions].sort((a, b) => {
        const pa = a.split(/[.-]/).map(Number)
        const pb = b.split(/[.-]/).map(Number)
        for (let i = 0; i < 3; i += 1) {
          if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
        }
        return 0
      })
      ok(JSON.stringify(versions) === JSON.stringify(sorted), '版本按降序排列（首个即推荐版本）')

      // 每个版本的仓库地址必须跟 package.json 的 repository 一致，
      // 否则用户点「仓库」跳到别处（本仓库曾指向上游 fork）
      const declared = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
      const mismatched = plugin.versions.filter(v => v.source.type === 'git' && v.source.url !== declared)
      ok(mismatched.length === 0, `git 源地址与 package.json repository 一致${mismatched.length ? `（不一致：${mismatched.map(v => v.source.url).join(',')}）` : ''}`)

      // 同一版本不能出现两次（重复会让版本列表出现两行一样的东西）
      ok(new Set(versions).size === versions.length, '版本号无重复')

      // 图标相对路径必须指向真实存在的文件（相对 market/ 解析）
      const iconRef = plugin.icon
      if (iconRef && !/^https?:|^data:/.test(iconRef)) {
        const iconPath = join(dirname(INDEX), iconRef)
        ok(existsSync(iconPath), `相对图标能解析到真实文件（${iconRef}）`)
      }
    }
  }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
