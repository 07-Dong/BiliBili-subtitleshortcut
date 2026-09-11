/**
 * setkey.js —— 按键捕获
 *
 * 由「改按键.bat」调用。让用户按一下想用的键，写进 `配置\按键.txt`。
 *
 * 为什么在这里捕获而不是在播放器页面里：
 *   页面里能拿到精确的 KeyboardEvent.code，但要求客户端必须开着、且打开了视频。
 *   终端捕获没有前置条件，代价是需要一张字节 → code 的映射表。
 *   单键场景表很小，值得。
 */

'use strict';

const readline = require('readline');
const {
  readKeyConfig,
  reservedReason,
  writeKeyConfig,
  KEY_FILE,
  RESERVED,
} = require('./keys');

// ──────────────────────────────────────────────────────────
// 字节 → 浏览器 KeyboardEvent.code
// ──────────────────────────────────────────────────────────

const CHAR_TO_CODE = {
  ' ': 'Space',
  '=': 'Equal',      '+': 'Equal',
  '-': 'Minus',      '_': 'Minus',
  '/': 'Slash',      '?': 'Slash',
  '\\': 'Backslash', '|': 'Backslash',
  ',': 'Comma',      '<': 'Comma',
  '.': 'Period',     '>': 'Period',
  ';': 'Semicolon',  ':': 'Semicolon',
  "'": 'Quote',      '"': 'Quote',
  '[': 'BracketLeft',  '{': 'BracketLeft',
  ']': 'BracketRight', '}': 'BracketRight',
  '`': 'Backquote',  '~': 'Backquote',
};

const SEQ_TO_CODE = {
  '\x1b[A': 'ArrowUp',   '\x1b[B': 'ArrowDown',
  '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft',
  '\x1b[H': 'Home',      '\x1b[F': 'End',
  '\x1b[2~': 'Insert',   '\x1b[3~': 'Delete',
  '\x1b[5~': 'PageUp',   '\x1b[6~': 'PageDown',
  '\x1bOP': 'F1', '\x1bOQ': 'F2', '\x1bOR': 'F3', '\x1bOS': 'F4',
  '\x1b[15~': 'F5',  '\x1b[17~': 'F6',  '\x1b[18~': 'F7',
  '\x1b[19~': 'F8',  '\x1b[20~': 'F9',  '\x1b[21~': 'F10',
  '\x1b[23~': 'F11', '\x1b[24~': 'F12',
};

/**
 * 中文输入法送来的全角标点 → 它对应的物理键。
 *
 * 开着中文输入法时，按反斜杠键得到的是「、」而不是「\」，终端交给我们的
 * 就是这个全角字符。不认它的话，用户想绑回默认键会看到"认不出这个键"。
 */
const IME_TO_CODE = {
  '、': 'Backslash', '\\': 'Backslash', '|': 'Backslash',
  '。': 'Period',    '．': 'Period',
  '，': 'Comma',
  '；': 'Semicolon', '：': 'Semicolon',
  '？': 'Slash',     '／': 'Slash',
  '！': 'Digit1',
  '“': 'Quote', '”': 'Quote', '‘': 'Quote', '’': 'Quote',
  '【': 'BracketLeft',  '「': 'BracketLeft',  '『': 'BracketLeft',
  '】': 'BracketRight', '」': 'BracketRight', '』': 'BracketRight',
  '－': 'Minus', '—': 'Minus',
  '＝': 'Equal', '＋': 'Equal',
  '·': 'Backquote', '～': 'Backquote',
  '（': 'Digit9', '）': 'Digit0',
  '《': 'Comma', '》': 'Period',
};

/**
 * GBK 双字节 → 字符。只覆盖常见标点。
 * 控制台若不是 UTF-8 代码页，输入法送来的是 GBK 字节。
 */
const GBK_PUNCT = new Map([
  [0xA1A2, '、'], [0xA1A3, '。'], [0xA3AC, '，'], [0xA3BB, '；'],
  [0xA3BA, '：'], [0xA3BF, '？'], [0xA3A1, '！'], [0xA1B0, '“'],
  [0xA1B1, '”'], [0xA1AE, '‘'], [0xA1AF, '’'], [0xA1BE, '（'],
  [0xA1BF, '）'], [0xA3DB, '－'], [0xA3DD, '＝'], [0xA1AA, '—'],
  [0xA1A4, '·'], [0xA3DE, '～'], [0xA1B6, '《'], [0xA1B7, '》'],
  [0xA3D6, '＋'],
]);

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * 把原始字节解成 { code } 或 { error, raw }。
 * 认不出来时一并回传原始字节，方便现场判断编码 —— 别让用户卡在死胡同里。
 */
function decode(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input), 'binary');
  const latin = buf.toString('binary');

  // ① 转义序列与控制键（按单字节/ASCII 判断）
  if (SEQ_TO_CODE[latin]) return { code: SEQ_TO_CODE[latin] };
  if (latin === '\x1b') return { code: 'Escape' };
  if (latin === '\r' || latin === '\n') return { code: 'Enter' };
  if (latin === '\t') return { code: 'Tab' };
  if (latin === '\x7f' || latin === '\b') return { code: 'Backspace' };

  // ② 单个 ASCII 可打印字符
  if (buf.length === 1) {
    const ch = latin;

    if (CHAR_TO_CODE[ch]) return { code: CHAR_TO_CODE[ch] };

    if (ch >= 'a' && ch <= 'z') return { code: 'Key' + ch.toUpperCase() };
    if (ch >= 'A' && ch <= 'Z') return { code: 'Key' + ch.toUpperCase() };
    if (ch >= '0' && ch <= '9') return { code: 'Digit' + ch };

    const n = ch.charCodeAt(0);
    if (n < 0x20) {
      return { error: '不支持组合键（Ctrl / Alt 之类），请只按一个键' };
    }
  }

  // ③ 多字节：输入法送来的全角标点
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�') && utf8.length === 1 && IME_TO_CODE[utf8]) {
    return { code: IME_TO_CODE[utf8] };
  }

  // ④ 换 GBK 再试一次（控制台不是 UTF-8 代码页时走这条）
  if (buf.length === 2) {
    const ch = GBK_PUNCT.get((buf[0] << 8) | buf[1]);
    if (ch && IME_TO_CODE[ch]) return { code: IME_TO_CODE[ch] };
  }

  return { error: '认不出这个键', raw: hex(buf) };
}

/** 可手工输入的键名集合（用于兜底） */
function validCodeNames() {
  const set = new Set();
  for (let i = 0; i < 26; i++) set.add('Key' + String.fromCharCode(65 + i));
  for (let i = 0; i <= 9; i++) set.add('Digit' + i);
  for (const v of Object.values(CHAR_TO_CODE)) set.add(v);
  for (const v of Object.values(SEQ_TO_CODE)) set.add(v);
  for (const [k] of RESERVED) set.add(k);
  for (const extra of ['Space', 'Enter', 'Tab', 'Escape', 'Backspace',
                       'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    set.add(extra);
  }
  return set;
}

// ──────────────────────────────────────────────────────────
// 捕获
// ──────────────────────────────────────────────────────────

/** 缓冲区末尾是不是一个还没读完的 UTF-8 多字节序列 */
function utf8Incomplete(buf) {
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i--) {
    const b = buf[i];
    if (b < 0x80) continue;            // 后续字节，继续往前找首字节
    if (b >= 0xc0) {                    // 首字节
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return buf.length - i < need;
    }
  }
  return false;
}

/** 读一次按键，返回 { code } 或 { error } */
function captureOnce() {
  return new Promise((resolve) => {
    // 非交互式环境（管道、重定向）下拿不到原始按键
    if (!process.stdin.isTTY) {
      resolve({ error: '当前不是交互式终端，无法捕获按键' });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buf = Buffer.alloc(0);
    let escTimer = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(escTimer);
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(result);
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      // 单独一个 ESC 也可能是方向键序列的开头，等一下看有没有后续
      if (buf.length === 1 && buf[0] === 0x1b) {
        clearTimeout(escTimer);
        escTimer = setTimeout(
          () => finish(decode(Buffer.from([0x1b]))), 60,
        );
        return;
      }

      // 输入法的全角字符是多字节的，可能分几次到达
      if (utf8Incomplete(buf)) return;

      finish(decode(buf));
    };

    process.stdin.on('data', onData);
  });
}

function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// ──────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────

const line = (s = '') => console.log(s);

async function main() {
  const { key: current, reserved } = readKeyConfig();

  line();
  line('  ========================================');
  line('    B站字幕快捷键 —— 改按键');
  line('  ========================================');
  line();
  line(`  当前按键：${current}`);
  line();

  const nameSet = validCodeNames();

  for (;;) {
    line('  请按下你想用的键…（按 Esc 取消）');
    line();

    const r = await captureOnce();
    line();

    // 取消
    if (r.code === 'Escape' && !r.error) {
      line('  已取消，未做任何修改。');
      line();
      return;
    }

    // 认不出来 —— 给手工输入的机会，不让流程卡死
    if (r.error) {
      line(`  ✗ ${r.error}`);
      // 认不出来时把原始字节亮出来，别让用户卡在死胡同
      if (r.raw) line(`    收到的原始字节：${r.raw}`);
      line();
      const manual = await askLine('  可以直接输入键名（例如 KeyQ、Backslash），或按回车重来：');
      if (!manual) { line(); continue; }
      if (!nameSet.has(manual)) {
        line(`  ✗ 「${manual}」不是有效的键名。`);
        line();
        continue;
      }
      r.code = manual;
    }

    // 冲突检查
    const reason = reservedReason(r.code, reserved);
    if (reason) {
      line(`  ✗ 「${r.code}」被 B站播放器占用了（${reason}），不能用。`);
      line();
      line('    播放器已占用的键：');
      for (const [code, desc] of reserved) {
        line(`      ${code.padEnd(14)} ${desc}`);
      }
      line();
      line('    换个键再试。');
      line();
      continue;
    }

    writeKeyConfig(r.code);

    line(`  ✓ 已保存：${r.code}`);
    line();
    line(`    写入位置：${KEY_FILE}`);
    line('    重新双击「启动.bat」后生效。');
    line();
    return;
  }
}

if (require.main === module) {
  main().catch((err) => {
    try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
    console.error(`\n✗ 出错：${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { decode, validCodeNames, captureOnce };
