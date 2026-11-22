/**
 * 交付前自检：AST 语法解析 + 配置 Schema 校验 + 响应信封校验 + 清单完整性。
 * 任一失败都会以非零码退出（“盖章才能出门”）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const errors = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    errors.push({ name, error: error instanceof Error ? error.message : String(error) });
    results.push({ name, ok: false });
  }
}

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      walkJs(full, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

await check('AST 语法解析（node --check）', () => {
  const files = walkJs(root);
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${file} 语法错误：${r.stderr || r.stdout}`);
  }
  return `${files.length} 个文件通过`;
});

await check('package.json 清单完整', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'type', 'exports', 'dsh']) {
    if (!pkg[key]) throw new Error(`缺少 ${key}`);
  }
  if (pkg.type !== 'module') throw new Error('type 必须是 module');
  if (!pkg.engines || !pkg.engines.node) throw new Error('缺少 engines.node');
  if (!Array.isArray(pkg.os) || !pkg.os.includes('win32')) throw new Error('os 声明不完整');
  if (!pkg.dsh.bundle || !pkg.dsh.bundle.patch) throw new Error('缺少 dsh.bundle.patch');
  if (!pkg.dsh.client || pkg.dsh.client.platform !== 'web') throw new Error('缺少 web client 声明');
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
    if (!existsSync(join(root, rel))) throw new Error(`缺少文件 ${rel}`);
  }
  return pkg.name + '@' + pkg.version;
});

await check('locale 元数据', () => {
  for (const lang of ['zh', 'en']) {
    const data = JSON.parse(readFileSync(join(root, 'locale', lang + '.json'), 'utf8'));
    if (!data.meta || !data.meta.title || !data.meta.description) throw new Error(`${lang} 缺少 meta.title / description`);
  }
  return 'zh/en 均完整';
});

await check('cordis.patch.yml 基本结构', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  if (!/- insert:/u.test(text)) throw new Error('缺少 insert');
  if (!/id: qqbot-guard/u.test(text)) throw new Error('缺少 id: qqbot-guard');
  if (!/name: dsh-qqbot-guard/u.test(text)) throw new Error('缺少 name: dsh-qqbot-guard');
  return '通过';
});

await check('配置 Schema 与归一化', async () => {
  const { Config, normalizeSettings } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href);
  if (!Config || typeof Config !== 'function') throw new Error('Config 不是 schemastery Schema');
  const parsed = Config({ appId: '123', dataDir: '' });
  if (parsed.appId !== '123') throw new Error('Config 未保留 appId');
  if (typeof parsed.appSecret !== 'string') throw new Error('Config 缺少 appSecret 默认值');
  const json = Config.toJSON();
  const top = json.refs && json.refs[json.uid];
  if (!top || top.type !== 'object') throw new Error('Config 必须是 object schema');
  if (normalizeSettings({ appSecret: 's' }).value.appSecret !== 's') throw new Error('secret 未保留');
  const r = normalizeSettings({
    appId: '123',
    moderation: { action: 'kick', muteSeconds: 999999999, keywords: ['a', 'a', 3] },
    join: { welcome: { variants: ['x'] } },
  });
  if (r.value.appId !== '123') throw new Error('appId 未保留');
  if (r.value.moderation.action !== 'kick') throw new Error('action 未保留');
  if (r.value.moderation.muteSeconds > 30 * 24 * 3600) throw new Error('muteSeconds 未限幅');
  if (r.value.moderation.keywords.length !== 1) throw new Error('keywords 未去重/过滤');
  return '通过';
});

await check('响应信封 Schema', async () => {
  const { ok, fail, assertEnvelope } = await import(pathToFileURL(join(root, 'lib', 'envelope.js')).href);
  assertEnvelope(ok({ test: true }));
  assertEnvelope(fail('E', '错误'));
  return '通过';
});

await check('违规规则引擎', async () => {
  const { matchRules, decideAction } = await import(pathToFileURL(join(root, 'lib', 'moderation.js')).href);
  const moderation = {
    keywords: ['坏话'], regexes: [], detectLinks: false, linkWhitelist: [],
    spam: { enabled: false }, action: 'warn', escalation: { enabled: true, violations: 3, action: 'kick' },
  };
  const hits = matchRules('你在说坏话', moderation);
  if (!hits.length) throw new Error('关键词未命中');
  if (decideAction(hits, 2, moderation).action !== 'kick') throw new Error('升级动作未生效');
  return '通过';
});

await check('跨平台兼容性自检', async () => {
  const { checkCompat, probeNetwork } = await import(pathToFileURL(join(root, 'lib', 'compat.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'qqg-validate-'));
  try {
    const c = checkCompat({ dataDir: dir, webAvailable: true });
    if (!c.checks || c.checks.length < 8) throw new Error('兼容性检查项过少');
    for (const id of ['node', 'platform', 'arch', 'fetch', 'abort', 'dataDir', 'web']) {
      if (!c.checks.some((x) => x.id === id)) throw new Error('缺少检查项 ' + id);
    }
    if (typeof probeNetwork !== 'function') throw new Error('缺少网络探测函数');
    return `${c.platform}/${c.arch} · Node ${c.node} · 必检通过=${c.ok}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('前端模块 ID 一致', () => {
  const text = readFileSync(join(root, 'client.js'), 'utf8');
  if (!text.includes("id: 'dsh-qqbot-guard'")) throw new Error('client id 不一致');
  if (!text.includes("'settings.section'")) throw new Error('未注册设置分区');
  return '通过';
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -> ' + r.detail : ''}`);
}
if (errors.length) {
  console.error('\n自检失败：');
  for (const e of errors) console.error(`- ${e.name}: ${e.error}`);
  process.exit(1);
}
console.log('\n全部自检通过。');
