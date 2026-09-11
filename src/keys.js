/**
 * keys.js —— 按键配置的读写与校验
 *
 * 配置文件是 `配置\按键.txt`，用户唯一需要碰的文件。
 * 首次运行时自动生成带注释的模板，用户不用手写。
 *
 * 格式用显式分节，避免解析歧义：
 *
 *   [按键]
 *   Backslash
 *
 *   [冲突]
 *   Space = 播放/暂停
 *   ...
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '配置');
const KEY_FILE = path.join(CONFIG_DIR, '按键.txt');
const DEFAULT_KEY = 'Backslash';

/**
 * 播放器已占用的键。
 *
 * 这份表是**实测**得到的，不是照常识猜的 —— 来源是客户端 HTTP 缓存里的
 * 播放器 bundle（%APPDATA%\bilibili\Cache\Cache_Data\f_0001f8，明文 JS），
 * 逐条读它的 initKeydownMap() 注册表和 switch 分发分支得出。
 *
 * 注意 Q/W/E/R/G 看着像"空闲字母"，实际都被占用了（点赞/投币/收藏/三连/关注），
 * 别把它们当安全选择推荐出去。
 */
const RESERVED = [
  ['Space',        '播放/暂停'],
  ['ArrowLeft',    '后退 5 秒'],
  ['ArrowRight',   '前进 5 秒（长按变 3 倍速）'],
  ['ArrowUp',      '音量 +10%'],
  ['ArrowDown',    '音量 -10%'],
  ['Escape',       '退出全屏'],
  ['Enter',        '聚焦弹幕输入框'],
  ['Tab',          '焦点切换'],
  ['KeyF',         '全屏'],
  ['KeyD',         '开/关弹幕'],
  ['KeyM',         '静音'],
  ['KeyQ',         '点赞（长按一键三连）'],
  ['KeyW',         '投币'],
  ['KeyE',         '收藏'],
  ['KeyR',         '长按一键三连'],
  ['KeyG',         '关注 UP 主'],
  ['BracketLeft',  '上一个 P'],
  ['BracketRight', '下一个 P'],
  ['Digit1',       '弹幕投票 1'],
  ['Digit2',       '弹幕投票 2'],
  ['Digit3',       '弹幕投票 3'],
  ['Digit4',       '弹幕投票 4'],
];

const RESERVED_MAP = new Map(RESERVED);

/** 生成配置文件模板（含完整注释与冲突清单） */
function template() {
  const pad = Math.max(...RESERVED.map(([k]) => k.length));
  const reservedLines = RESERVED
    .map(([k, d]) => `${k.padEnd(pad)} = ${d}`)
    .join('\n');

  return `# ══════════════════════════════════════════════
#   字幕开关 —— 按键配置
# ══════════════════════════════════════════════
#
# 【怎么改】
#   推荐：双击项目根目录的「改按键.bat」，按一下你想用的键就行。
#   也可以直接改下面 [按键] 那一节，保存后重新双击「启动.bat」。
#
# 【键名怎么写】
#   字母   KeyA … KeyZ
#   数字   Digit0 … Digit9
#   符号   Equal(=)  Minus(-)  Slash(/)  Backslash(\\)  Comma(,)
#          Period(.)  Semicolon(;)  Quote(')  BracketLeft([)  BracketRight(])
#   其他   Space  Enter  Tab  Escape  Backquote(\`)
#
# 【冲突清单】
#   [冲突] 一节里列的键被 B站播放器自己占用了，选它们会导致
#   一次按键触发两个功能，所以程序会拒绝。
#
#   如果 B站 以后改了快捷键，或者你确认某个键其实没被占用，
#   把那一行删掉、或在行首加 # 注释掉即可。

[按键]
${DEFAULT_KEY}

[冲突]
${reservedLines}
`;
}

/**
 * 解析配置文本。
 * 分节标记是 [按键] 和 [冲突]，其余行按 # 注释与空行跳过。
 */
function parseConfig(raw) {
  let section = null;
  let key = null;
  const reserved = new Map();

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();

    if (/^\[按键\]$/.test(t)) { section = 'key'; continue; }
    if (/^\[冲突\]$/.test(t)) { section = 'reserved'; continue; }
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;

    if (section === 'key') {
      if (!key) key = t;                       // 只取第一条
    } else if (section === 'reserved') {
      const [name, ...rest] = t.split('=');
      const code = name.trim();
      if (code) reserved.set(code, rest.join('=').trim() || '(播放器占用)');
    }
  }

  return { key, reserved };
}

/** 配置文件不存在就按模板生成 */
function ensureConfigFile() {
  if (fs.existsSync(KEY_FILE)) return false;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, template(), 'utf8');
  return true;
}

/** 读取配置；文件缺失或键名为空时回落到默认键 */
function readKeyConfig() {
  ensureConfigFile();
  let parsed = { key: null, reserved: new Map() };
  try {
    parsed = parseConfig(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch { /* 读不了就用默认 */ }

  return {
    key: parsed.key || DEFAULT_KEY,
    reserved: parsed.reserved.size ? parsed.reserved : new Map(RESERVED_MAP),
    fromConfig: Boolean(parsed.key),
  };
}

/** 查一个键是否被播放器占用；占用则返回说明，否则 null */
function reservedReason(code, reserved) {
  return (reserved || RESERVED_MAP).get(code) || null;
}

/**
 * 只改写 [按键] 那一节，其余内容（含用户手动注释掉的冲突行）原样保留。
 * 配置文件不存在时先按模板生成，再改写。
 */
function writeKeyConfig(code) {
  ensureConfigFile();

  const raw = fs.readFileSync(KEY_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  let inKeySection = false;
  let wrote = false;

  for (const line of lines) {
    const t = line.trim();

    if (/^\[按键\]$/.test(t)) {
      inKeySection = true;
      out.push(line);
      continue;
    }
    if (/^\[冲突\]$/.test(t)) {
      // 离开 [按键] 节；若还没写过就补上
      if (inKeySection && !wrote) { out.push(code); wrote = true; }
      inKeySection = false;
      out.push(line);
      continue;
    }

    if (inKeySection) {
      // 覆盖该节第一条有效内容，注释与空行保留
      if (!wrote && t && !t.startsWith('#')) {
        out.push(code);
        wrote = true;
      } else if (!wrote) {
        out.push(line);
      }
      // 多余的旧键名直接丢弃
      continue;
    }

    out.push(line);
  }

  if (!wrote) out.push(code);

  fs.writeFileSync(KEY_FILE, out.join('\n'), 'utf8');
}

module.exports = {
  CONFIG_DIR,
  KEY_FILE,
  DEFAULT_KEY,
  RESERVED,
  template,
  parseConfig,
  ensureConfigFile,
  readKeyConfig,
  reservedReason,
  writeKeyConfig,
};
