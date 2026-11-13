/**
 * DSH 插件市场索引（format 1）的校验规则。
 *
 * 单独成文件，是为了让**生成器**和**测试**用同一份规则：
 * 各写一份的话，实现改错了测试照样绿（本仓库踩过这个形态）。
 *
 * 这些规则不是抄文档来的，是 2026-11-13 拿官方
 * `@deepseek-ai/dsh-plugin-market-index@0.2.1-alpha.4` 的 `parseMarketIndex`
 * 逐条实测出来的。实测结论见每条注释。
 *
 * 本模块**故意不依赖**那个包：
 *   它是 alpha 版、只有 6 个传递依赖，但装一次要几十秒（本机 npm 网络很慢），
 *   而 CI/离线环境不该为了校验一份 JSON 去联网。规则很稳定。
 * 想用官方包复核，见 tests/market-index-sim.mjs 里 `--official` 分支的说明。
 */

/** 合法 npm 包名：可选 scope，后面是包名。 */
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * 精确 SemVer。
 * 实测：写 `^0.24.5` 会被拒，报 `must be an exact SemVer version`。
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * git 源 commit：**40 位小写** SHA。
 * 实测：写 `b94f5ea`（7 位）或大写都被拒，
 * 报 `must be a lowercase 40-hex-digit commit SHA`。
 */
const COMMIT_RE = /^[0-9a-f]{40}$/

/**
 * git 源 url：规范 https 地址。
 * 实测要求：至少两段非空路径、无结尾斜杠、无凭据、无 query/fragment、
 * 不以 .tgz/.tar.gz 结尾（那是 tarball 不是仓库，官方报
 * `must name a repository, not a tarball`）。
 */
const REPO_URL_RE = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+$/
const TARBALL_RE = /\.(?:tgz|tar\.gz)$/i

/**
 * 校验一份索引文档。
 *
 * @param {unknown} doc 解析后的 JSON
 * @returns {string[]} 问题清单；空数组 = 通过
 */
export function validateMarketIndex(doc) {
  /** @type {string[]} */
  const problems = []
  const bad = msg => problems.push(msg)

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['索引必须是一个 JSON 对象']
  }
  if (doc.format !== 1) {
    bad(`format 必须是 1（现在是 ${JSON.stringify(doc.format)}）`)
  }
  if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) {
    return [...problems, 'plugins 必须是非空数组']
  }

  for (const [i, plugin] of doc.plugins.entries()) {
    const at = `plugins[${i}]`
    if (!plugin || typeof plugin !== 'object') {
      bad(`${at} 必须是对象`)
      continue
    }
    if (!NAME_RE.test(plugin.name ?? '')) {
      bad(`${at}.name 不是合法 npm 包名：${JSON.stringify(plugin.name)}`)
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
      bad(`${at}.versions 必须是非空数组`)
      continue
    }

    for (const [j, v] of plugin.versions.entries()) {
      const vat = `${at}.versions[${j}]`
      if (!v || typeof v !== 'object') {
        bad(`${vat} 必须是对象`)
        continue
      }

      if (!SEMVER_RE.test(v.version ?? '')) {
        bad(`${vat}.version 必须是精确 SemVer（不能带 ^ ~ 等范围符号）：${JSON.stringify(v.version)}`)
      }

      // 实测：毫秒会被拒，报 `must be an integer number of Unix seconds in [0, 10^11)`
      const ts = v.publishTimestamp
      if (!Number.isInteger(ts) || ts < 0 || ts >= 1e11) {
        bad(`${vat}.publishTimestamp 必须是整数秒（毫秒会被拒）：${ts}`)
      }

      const src = v.source
      if (!src || typeof src !== 'object') {
        bad(`${vat}.source 缺失`)
        continue
      }
      if (src.type === 'git') {
        if (!COMMIT_RE.test(src.commit ?? '')) {
          bad(`${vat}.source.commit 必须是 40 位小写 SHA：${JSON.stringify(src.commit)}`)
        }
        if (!REPO_URL_RE.test(src.url ?? '')) {
          bad(`${vat}.source.url 必须是规范 https 仓库地址：${JSON.stringify(src.url)}`)
        } else if (TARBALL_RE.test(src.url)) {
          // 官方原文：`must name a repository, not a tarball`
          bad(`${vat}.source.url 必须指向仓库而不是 tarball：${JSON.stringify(src.url)}`)
        }
        // path 可选：monorepo 子目录。段内只允许 ASCII 字母数字与 ._@+-，且不能是 . 或 ..
        if (src.path !== undefined) {
          const okPath =
            typeof src.path === 'string' &&
            src.path.split('/').every(s => /^[A-Za-z0-9._@+-]+$/.test(s) && s !== '.' && s !== '..')
          if (!okPath) bad(`${vat}.source.path 不合法：${JSON.stringify(src.path)}`)
        }
      } else if (src.type === 'npm') {
        // registry 可选；给了就必须是无凭据的 http(s) 地址
        if (src.registry !== undefined && !/^https?:\/\/[^\s]+$/.test(src.registry)) {
          bad(`${vat}.source.registry 不是合法地址：${JSON.stringify(src.registry)}`)
        }
      } else {
        bad(`${vat}.source.type 只能是 "npm" 或 "git"：${JSON.stringify(src.type)}`)
      }
    }
  }

  return problems
}

/**
 * 把索引里的版本对象换算成 pnpm 安装 spec —— 与官方 `marketInstallTarget` 一致。
 * 用来在 README / 日志里给出「别人实际会执行什么」。
 */
export function installSpec(pluginName, version) {
  const src = version.source
  if (src.type === 'npm') return `${pluginName}@${version.version}`
  const base = `git+${src.url.replace(/\/$/, '')}.git#${src.commit}`
  return src.path ? `${base}&path:${src.path}` : base
}
