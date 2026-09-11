/**
 * status.js —— 实时显示当前播放页的字幕状态，用于人工验证。
 *
 * 用法: node status.js
 *
 * 输出：
 *   - 当前视频标题
 *   - 有没有字幕（语言项数量）
 *   - 字幕开没开
 *   - 屏幕上正在显示的字幕文字
 */

'use strict';

const HOST = 'http://127.0.0.1:9222';

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m.id || !this.pending.has(m.id)) return;
      this.pending.get(m.id)(m.result);
      this.pending.delete(m.id);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
}

const PROBE = `(function(){
  var m = document.querySelector('.bili-subtitle-x-subtitle-panel-major-group');
  var v = document.querySelector('video');
  var items = document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item');
  var active = document.querySelector('.bpx-player-ctrl-subtitle-language-item.bpx-state-active');
  return {
    title: document.title.slice(0, 45),
    hasSubtitle: items.length > 0,
    langCount: items.length,
    activeLang: active ? (active.textContent || '').trim() : null,
    onScreen: m ? (m.innerText || '') : '',
    paused: v ? v.paused : null,
    time: v ? Math.round(v.currentTime) : null,
    injected: !!window.__biliSubtitleHotkey,
  };
})()`;

(async () => {
  let targets;
  try {
    targets = await (await fetch(`${HOST}/json/list`)).json();
  } catch {
    console.log('\n✗ 连不上调试端口（9222）。客户端可能不是通过启动器打开的。\n');
    process.exit(1);
  }

  const t = targets.filter((x) => x.type === 'page' && /player\.html/.test(x.url || ''))[0];
  if (!t) {
    console.log('\n· 客户端里还没有打开视频页面。请在客户端里打开一节有字幕的课。\n');
    process.exit(0);
  }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new CDP(ws);
  const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const s = r.result?.value;

  console.log('\n──────── 当前状态 ────────');
  console.log(`视频    : ${s.title}`);
  console.log(`有字幕  : ${s.hasSubtitle ? `是（${s.langCount} 种）` : '否 —— 按「、」不会有反应，正常'}`);
  console.log(`字幕开关: ${s.activeLang ? `已开（${s.activeLang}）` : '关闭'}`);
  console.log(`屏幕文字: ${s.onScreen ? `「${s.onScreen}」` : '(空)'}`);
  console.log(`播放中  : ${s.paused ? '否（暂停）' : '是'}  第 ${s.time} 秒`);
  console.log(`快捷键  : ${s.injected ? '已注入 ✓' : '未注入 ✗ —— 守卫没在运行？'}`);
  console.log('──────────────────────────\n');

  ws.close();
  process.exit(0);
})().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
