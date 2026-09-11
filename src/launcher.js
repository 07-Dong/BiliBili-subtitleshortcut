/**
 * B站字幕快捷键 —— 启动器
 *
 * 职责：
 *   1. 找到 B站客户端装在哪
 *   2. 用它 + 调试端口启动
 *   3. 把 src/inject.js 注入到播放器页面，并在切换视频后自动重注入
 *
 * 不修改客户端任何文件。
 *
 * 用法：
 *   node launcher.js          正常启动
 *   node launcher.js --check  只做体检，不启动
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { readKeyConfig, ensureConfigFile, reservedReason, KEY_FILE } = require('./keys');

const PORT = 9222;
const HOST = `http://127.0.0.1:${PORT}`;
const INJECT_PATH = path.join(__dirname, 'inject.js');

const PROJECT_DIR = path.join(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_DIR, '配置');

/** 客户端路径缓存。自动回填，也允许用户手改。 */
const MANUAL_PATH_FILE = path.join(CONFIG_DIR, '客户端路径.txt');
const PID_FILE = path.join(CONFIG_DIR, '运行状态.json');
const LOG_FILE = path.join(CONFIG_DIR, '运行日志.txt');
const SHORTCUT_FILE = path.join(PROJECT_DIR, 'B站字幕快捷键.lnk');

// ──────────────────────────────────────────────────────────
// 日志
//
// 正常是从「启动.vbs」隐藏启动的，控制台根本看不见，
// 所以所有输出必须同时落盘，否则出问题只能抓瞎。
// ──────────────────────────────────────────────────────────

let logStream = null;

function writeLog(args) {
  if (!logStream) return;
  const text = args
    .map((a) => (typeof a === 'string' ? a : String(a)))
    .join(' ');
  try { logStream.write(`${text}\n`); } catch { /* 忽略 */ }
}

// 模块加载时就接管，保证任何一行输出都不会漏
const _stdout = console.log.bind(console);
const _stderr = console.error.bind(console);
console.log = (...a) => { _stdout(...a); writeLog(a); };
console.error = (...a) => { _stderr(...a); writeLog(a); };

/** 开日志文件（每次启动覆盖，不会越写越大） */
function initLog() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  } catch { /* 落盘失败不该阻止启动 */ }
}

// ──────────────────────────────────────────────────────────
// 单实例
//
// 重复双击会起多个常驻进程，任务栏和内存都堆叠，得挡掉。
// ──────────────────────────────────────────────────────────

/** 已在运行则返回它的 pid，否则 null */
function alreadyRunning() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (!pid) return null;
    process.kill(pid, 0);        // 不抛异常 = 进程还活着
    return pid;
  } catch {
    // 文件不存在，或者进程已经死了（强杀会留下陈旧记录）
    return null;
  }
}

function writePid() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf8',
    );
  } catch { /* 忽略 */ }
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch { /* 已经没了 */ }
}

// ──────────────────────────────────────────────────────────
// PowerShell 调用（用 EncodedCommand 避免一切引号转义问题）
// ──────────────────────────────────────────────────────────

function powershell(script, timeout = 20000) {
  // 先把 stdout 统一成 UTF8。
  // PowerShell 5.1 在输出被重定向时按系统 OEM 代码页编码，中文路径（「哔哩哔哩.exe」）
  // 回传会乱码，导致下面的 existsSync 失败、该探测函数静默返回 null。
  // 在非中文 locale 的 Windows 上（如 CP437）尤其容易踩到。
  const encoded = Buffer.from(
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n${script}`,
    'utf16le',
  ).toString('base64');
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout, windowsHide: true },
  );
}

// ──────────────────────────────────────────────────────────
// 找客户端
// ──────────────────────────────────────────────────────────

/** 在目录里找主 exe（名字可能是中文） */
function findExeIn(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const name of ['哔哩哔哩.exe', 'bilibili.exe']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  try {
    const hit = fs.readdirSync(dir).find(
      (f) => f.toLowerCase().endsWith('.exe') && !/^卸载|uninstall/i.test(f),
    );
    if (hit) return path.join(dir, hit);
  } catch { /* 无权限 */ }
  return null;
}

/** 若客户端已在运行，直接取它的路径 —— 最快也最准 */
function findByRunningProcess() {
  try {
    const out = powershell(`
      Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -match 'bili' -or $_.Path -match '哔哩') } |
        Select-Object -First 1 -ExpandProperty Path
    `, 15000);
    const p = out.trim().split(/\r?\n/)[0];
    if (p && fs.existsSync(p)) return { exe: p, how: '运行中的进程' };
  } catch { /* 没在跑 */ }
  return null;
}

/** 解析开始菜单里的快捷方式 */
function findByStartMenu() {
  try {
    const out = powershell(`
      $sh = New-Object -ComObject WScript.Shell
      Get-ChildItem 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
                    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '哔哩|bili' } |
        ForEach-Object { $sh.CreateShortcut($_.FullName).TargetPath } |
        Select-Object -Unique
    `, 15000);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p.toLowerCase().endsWith('.exe') && fs.existsSync(p)) {
        return { exe: p, how: '开始菜单快捷方式' };
      }
    }
  } catch { /* 没有快捷方式 */ }
  return null;
}

/** 从注册表卸载信息里的 DisplayIcon 反推 */
function findByRegistry() {
  try {
    const out = powershell(`
      $roots = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      )
      Get-ChildItem $roots -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayIcon -match 'bili' -or $_.DisplayName -match '哔哩|bili' } |
        Select-Object -First 1 -ExpandProperty DisplayIcon
    `, 20000);
    const icon = out.trim().split(/\r?\n/)[0].replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '');
    if (icon) {
      const exe = findExeIn(path.win32.dirname(icon));
      if (exe) return { exe, how: '注册表' };
    }
  } catch { /* 查不到 */ }
  return null;
}

/**
 * 手动指定：读项目根目录的「客户端路径.txt」。
 * 自动查找都失败时，让对方把路径粘进那个文件即可 —— 不用改代码。
 */
function findByManualFile() {
  try {
    const raw = fs.readFileSync(MANUAL_PATH_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const v = line.trim().replace(/^"|"$/g, '');
      if (!v || v.startsWith('#')) continue;
      if (fs.existsSync(v)) return { exe: v, how: '客户端路径.txt' };
    }
  } catch { /* 没有这个文件，正常 */ }
  return null;
}

/** 常见安装位置兜底 —— 先通用约定，后个别布局 */
function findByCommonPaths() {
  const roots = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
  const subs = [
    'Program Files\\bilibili', 'Program Files (x86)\\bilibili',
    'Program Files\\哔哩哔哩', 'Program Files (x86)\\哔哩哔哩',
    'Program Files\\哔哩哔哩 PC', 'Program Files (x86)\\哔哩哔哩 PC',
    'bilibili\\bilibili', 'bilibili', '哔哩哔哩',
    'bili\\bilibili',
  ];
  for (const root of roots) {
    for (const sub of subs) {
      const exe = findExeIn(`${root}\\${sub}`);
      if (exe) return { exe, how: '常见路径' };
    }
  }
  // 少数版本装进用户目录
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const exe = findExeIn(path.join(local, 'bilibili'))
             || findExeIn(path.join(local, 'Programs', 'bilibili'));
    if (exe) return { exe, how: '用户目录' };
  }
  return null;
}

/** 把找到的路径记下来 —— 下次启动直接命中，省掉约 4 秒探测 */
function cacheClientPath(exe) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      MANUAL_PATH_FILE,
      '# 自动记录，一般不用改。\n'
      + '# B站 换了安装位置的话，把下面这行改成新路径；\n'
      + '# 或者直接删掉本文件，让它重新查找。\n'
      + `${exe}\n`,
      'utf8',
    );
  } catch { /* 忽略 */ }
}

/**
 * 找客户端。
 *
 * 顺序很讲究：先查缓存文件（纯文件系统，约 0 毫秒），没命中才动用
 * PowerShell 那套四级探测（实测合计约 4.2 秒）。探测成功就回填缓存，
 * 所以只有第一次启动慢，之后是秒开。
 */
function findClient() {
  const cached = findByManualFile();
  if (cached) return cached;

  const found = findByRunningProcess()
             || findByStartMenu()
             || findByRegistry()
             || findByCommonPaths();

  if (found) cacheClientPath(found.exe);
  return found;
}

/**
 * 生成带 B站 图标的快捷方式。
 *
 * 图标直接指向客户端主程序，所以开箱就是 B站 的样子 —— 不用用户手动换图标。
 * 已存在就不动，免得覆盖用户自己改过的。
 */
function ensureShortcut(clientExe) {
  if (fs.existsSync(SHORTCUT_FILE)) return false;

  const vbs = path.join(PROJECT_DIR, '启动.vbs');
  if (!fs.existsSync(vbs)) return false;

  // 用单引号包住：PowerShell 不展开其中的 $ 等字符
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

  try {
    powershell(`
      $sh = New-Object -ComObject WScript.Shell
      $lnk = $sh.CreateShortcut(${q(SHORTCUT_FILE)})
      $lnk.TargetPath = 'wscript.exe'
      $lnk.Arguments = ${q(`"${vbs}"`)}
      $lnk.WorkingDirectory = ${q(PROJECT_DIR)}
      $lnk.IconLocation = ${q(`${clientExe},0`)}
      $lnk.Description = 'B站字幕快捷键'
      $lnk.Save()
    `, 15000);
  } catch { return false; }

  return fs.existsSync(SHORTCUT_FILE);
}

// ──────────────────────────────────────────────────────────
// CDP
// ──────────────────────────────────────────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => this._onMessage(e.data));
    ws.addEventListener('close', () => {
      for (const { rej } of this.pending.values()) rej(new Error('连接已关闭'));
      this.pending.clear();
      if (this.onClose) this.onClose();
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  _onMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m.id || !this.pending.has(m.id)) return;
    const { res, rej } = this.pending.get(m.id);
    this.pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
    else res(m.result);
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('无法建立调试连接')), { once: true });
  });
  return new CDP(ws);
}

async function listTargets() {
  const res = await fetch(`${HOST}/json/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isPlayerTarget = (t) => t.type === 'page' && /player\.html/.test(t.url || '');

// ──────────────────────────────────────────────────────────
// 注入与守卫
// ──────────────────────────────────────────────────────────

const attached = new Map();   // targetId -> { cdp, scriptId, fingerprint, connected }

/**
 * 注入脚本的内容指纹。
 * 用内容哈希而非 mtime —— 浮点时间戳比较不稳，会导致误判。
 */
const crypto = require('crypto');

const injectFingerprint = () =>
  crypto.createHash('sha1').update(fs.readFileSync(INJECT_PATH)).digest('hex');

async function attach(target) {
  const existing = attached.get(target.id);

  // 已经连上这个 target 就不再动它。
  // 热替换会在页面里留下摘不掉的旧监听器，导致一次按键触发多回，
  // 得不偿失 —— 改了 inject.js 就重开客户端（或刷新页面）即可。
  if (existing && existing.connected) return;

  // 把当前按键下发给页面 —— inject.js 从 window.__biliSubtitleKey 读
  const { key } = readKeyConfig();
  const source =
    `window.__biliSubtitleKey=${JSON.stringify(key)};\n` +
    fs.readFileSync(INJECT_PATH, 'utf8');

  let cdp;
  try {
    cdp = await connect(target.webSocketDebuggerUrl);
  } catch {
    attached.delete(target.id);
    return;
  }

  cdp.onClose = () => attached.delete(target.id);

  try {
    await cdp.send('Runtime.evaluate', { expression: source, returnByValue: true });
    await cdp.send('Page.enable');
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    attached.set(target.id, { cdp, scriptId: r.identifier, connected: true });
    console.log(`  ✓ 已注入：${(target.title || '(无标题)').slice(0, 45)}`);
  } catch (err) {
    attached.delete(target.id);
    console.log(`  ✗ 注入失败：${err.message}`);
  }
}

async function injectAll() {
  const targets = await listTargets();
  for (const t of targets.filter(isPlayerTarget)) await attach(t);
}

/**
 * 常驻守卫：轮询新出现的播放页。
 *
 * 找不到播放页时不能静默空转 —— 那样用户只看到「按了没反应」，
 * 完全无从判断是没打开视频、还是客户端改版了。所以攒够轮次就报一次。
 */
function watch() {
  let misses = 0;
  let warned = false;

  const timer = setInterval(async () => {
    let targets;
    try {
      targets = await listTargets();
    } catch {
      // 客户端可能已关闭；再连不上就退出，不留僵尸进程
      console.log('\n· 客户端已关闭，退出。');
      clearInterval(timer);
      process.exit(0);
    }

    const players = targets.filter(isPlayerTarget);

    if (players.length) {
      misses = 0;
      warned = false;
    } else if (++misses >= 15 && !warned) {
      warned = true;
      console.log('\n  ⚠ 一直没找到播放页，快捷键暂时不会生效。');
      console.log('    可能的原因：');
      console.log('      · 还没在客户端里打开视频 —— 打开任意视频就会自动生效');
      console.log('      · 客户端版本与脚本不匹配（播放页地址变了）');
      console.log('    客户端目前打开的页面：');
      for (const t of targets.filter((x) => x.type === 'page').slice(0, 8)) {
        console.log(`      ${(t.url || '(空)').slice(0, 88)}`);
      }
      console.log('');
    }

    for (const t of players) await attach(t);
  }, 2000);
}

// ──────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────

async function portUp() {
  try { await listTargets(); return true; } catch { return false; }
}

function clientRunning() {
  try {
    const out = powershell(`
      (Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -match 'bili' -or $_.Path -match '哔哩') } |
        Measure-Object).Count
    `, 15000);
    return parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  initLog();

  console.log('\n=== B站字幕快捷键 ===');
  console.log(`启动时间：${new Date().toLocaleString('zh-CN')}\n`);

  // 单实例：已经在跑就别再起一个，否则进程会堆叠
  const running = alreadyRunning();
  if (running && !checkOnly) {
    console.log(`· 已经在运行了（进程 ${running}），这次什么都不做。`);
    console.log('  想重启，请先双击「停止.bat」。');
    return;
  }

  if (!fs.existsSync(INJECT_PATH)) {
    console.error(`✗ 找不到注入脚本：${INJECT_PATH}`);
    process.exit(1);
  }

  // 配置文件不存在就生成一份带注释的模板，用户不用手写
  if (ensureConfigFile()) console.log(`· 已生成配置文件：${KEY_FILE}`);

  const { key, reserved } = readKeyConfig();
  const conflict = reservedReason(key, reserved);
  if (conflict) {
    console.error(`✗ 配置的按键「${key}」被 B站播放器占用了（${conflict}）。`);
    console.error('  这个键会同时触发播放器的功能，所以拒绝启动。');
    console.error(`  双击「改按键.bat」换一个，或直接编辑：${KEY_FILE}\n`);
    process.exit(1);
  }
  console.log(`· 字幕快捷键：${key === 'Backslash' ? '「、」（Backslash）' : key}`);

  // 已在调试模式运行：直接接管
  if (await portUp()) {
    console.log('· 检测到已在调试模式运行的客户端，直接接管');
    if (checkOnly) {
      console.log('✓ 体检通过（客户端已在调试模式运行）\n');
      return;
    }
    // 顺手补上路径缓存和快捷方式。
    // 缓存命中时几乎不耗时；第一次没缓存会走一遍探测，就一次。
    const found = findClient();
    if (found && ensureShortcut(found.exe)) {
      console.log('· 已生成快捷方式：B站字幕快捷键.lnk（可拖到桌面用）');
    }

    writePid();
    process.on('exit', clearPid);
    console.log('· 注入守卫已启动');
    await injectAll();
    watch();
    console.log('\n✓ 就绪。按「、」开/关字幕。');
    console.log('  停止请双击「停止.bat」。\n');
    return;
  }

  const client = findClient();
  if (!client) {
    console.error('\n✗ 没有找到 B站客户端。\n');
    console.error('  请依次检查：');
    console.error('    1. 确认装的是 B站「桌面客户端」，不是浏览器里的网页版');
    console.error('    2. 找到客户端主程序，复制它的完整路径');
    console.error('       （右键桌面上的 B站图标 → 打开文件所在位置 → 点地址栏复制）');
    console.error('    3. 把复制的路径粘进下面这个文件（没有就新建一个）：');
    console.error(`       ${MANUAL_PATH_FILE}`);
    console.error('       一行一个路径，保存后重新双击「启动.bat」\n');
    process.exit(1);
  }
  console.log(`· 客户端：${client.exe}`);
  console.log(`  （通过${client.how}找到）`);

  if (checkOnly) {
    console.log('\n✓ 体检通过，可以正常启动。\n');
    return;
  }

  // 首次找到客户端时顺手生成快捷方式（图标指向客户端主程序）
  if (ensureShortcut(client.exe)) {
    console.log('· 已生成快捷方式：B站字幕快捷键.lnk（可拖到桌面用）');
  }

  // 直接启动，不事先跑 clientRunning() ——
  // 那个查询要 2.4 秒，而正常路径下端口能起来就没必要问。
  // 只有失败时才回头查，把代价挪到出错路径上。
  writePid();
  process.on('exit', clearPid);

  console.log(`· 以调试模式启动（端口 ${PORT}）...`);
  spawn(client.exe, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portUp()) { ready = true; break; }
  }

  if (!ready) {
    // 失败才回头查原因，这里花 2.4 秒换来准确的报错
    if (clientRunning()) {
      console.error('\n✗ B站客户端已经在运行了，但不是调试模式。');
      console.error('  调试端口必须在启动时指定，没法事后补开。');
      console.error('  请完全退出客户端（包括右下角托盘图标），');
      console.error('  再重新双击「启动.vbs」。\n');
    } else {
      console.error('\n✗ 客户端启动了，但调试端口没响应。');
      console.error('  这个版本的客户端可能屏蔽了 --remote-debugging-port 参数。\n');
    }
    process.exit(1);
  }

  console.log('· 调试端口就绪，注入守卫');
  watch();
  await injectAll();

  console.log('\n✓ 就绪。');
  console.log('  在客户端里打开一个视频，按「、」即可开/关字幕。');
  console.log('  无字幕的视频按了不会有反应，这是正常的。');
  console.log('  停止请双击「停止.bat」。\n');
}

// 被 require 时不自动跑 main —— 方便单独测里面的函数
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ 出错：${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { findClient, ensureShortcut, cacheClientPath, alreadyRunning };
