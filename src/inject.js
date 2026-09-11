/**
 * 注入脚本 —— 在 B站播放器页面内部运行。
 *
 * 职责：监听按键，「、」键 → 切换字幕开关（开 ↔ 关）。
 * 手感等同于客户端自带的暂停键：监听器在页面内部，无进程间通信、无鼠标模拟。
 *
 * 这段代码通过 CDP 注入，不会写入客户端任何文件。
 */

(() => {
  'use strict';

  const VERSION = '6';

  /**
   * 代次标记：保证同一时刻只有一个 handler 真正干活。
   *
   * 热替换时旧 handler 的引用可能被新版覆盖而摘不掉，它会在每次按键时继续执行，
   * 导致一次按键触发两次。所以每个 handler 执行前先核对代次，不是最新的直接返回，
   * 孤儿监听器因此自动退化为空操作。
   */
  const gen = (window.__biliSubtitleGen = (window.__biliSubtitleGen || 0) + 1);

  /**
   * 触发键。由 launcher.js 在注入前下发 window.__biliSubtitleKey；
   * 没下发时（比如手工在控制台贴这段代码）回落到默认的反斜杠键。
   */
  const KEY_CODE = window.__biliSubtitleKey || 'Backslash';

  /**
   * 反斜杠键的字符匹配兜底。
   *
   * 这个物理键在中文输入法下产生「、」、英文下是「\」，而某些输入法状态下
   * 事件的 e.code 未必是 'Backslash' —— 只认 code 会漏掉。
   * 所以只要绑的还是这个键，就永远保留字符匹配，**与键值从哪来无关**。
   *
   * 注意别把它写成「没下发配置才启用」—— 启动器现在总会下发，
   * 那样等于把这条路关死，实测会让「、」直接失灵。
   */
  const KEY_LEGACY = KEY_CODE === 'Backslash' ? ['\\', '、'] : [];
  const WAIT_MS = 1200;
  const POLL_MS = 40;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const languageItems = () =>
    [...document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item')];

  const closeSwitch = () =>
    document.querySelector('.bpx-player-ctrl-subtitle-close-switch');

  /** 字幕当前是否开着 —— 语言项带高亮类即开 */
  const isOn = () =>
    !!document.querySelector('.bpx-player-ctrl-subtitle-language-item.bpx-state-active');

  /**
   * 触发一个元素的 click。
   *
   * 必须用 dispatchEvent 而非 el.click()：播放器用的是事件委托，
   * el.click() 不冒泡到它的委托层，点了等于没点（实测关闭开关尤其明显）。
   */
  function realClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  async function toggleSubtitle() {
    const deadline = Date.now() + WAIT_MS;

    while (Date.now() < deadline) {
      const items = languageItems();
      if (!items.length) {
        await sleep(POLL_MS);
        continue;
      }

      if (!isOn()) {
        realClick(items[0]);
        return { ok: true, action: 'on' };
      }

      const sw = closeSwitch();
      if (!sw) return { ok: false, reason: 'no-close-switch' };
      realClick(sw);
      return { ok: true, action: 'off' };
    }

    return { ok: false, reason: 'no-subtitle' };
  }

  const onKeydown = (e) => {
    if (window.__biliSubtitleGen !== gen) return;   // 已被更新的代次取代

    // Ctrl / Alt / Win 一律拦，两条匹配路径都一样 —— 这不是正常按键
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // 字符匹配：输入法产生的「、」走的可能就是这条路。
    // 这条路放行 Shift —— 那本来就是输入法的产物，不是用户按出来的组合键，
    // 而且有些输入法状态下事件会带着 shiftKey。
    if (!KEY_LEGACY.includes(e.key)) {
      if (e.code !== KEY_CODE) return;

      // 只认单键：Shift 也不认。
      // 「=」和「+」是同一个物理键（code 都是 Equal），不拦的话绑了「=」
      // 连按「+」也会一起触发。
      if (e.shiftKey) return;
    }

    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      return;
    }

    toggleSubtitle().then((r) => {
      if (!r.ok) console.debug('[字幕快捷键] 跳过：', r.reason);
    });
  };

  window.__biliSubtitleHotkey = true;
  window.__biliSubtitleHotkeyVersion = VERSION;
  window.__biliSubtitleHotkeyGen = gen;
  window.__biliSubtitleHotkeyHandler = onKeydown;
  window.addEventListener('keydown', onKeydown, true);

  const label = KEY_CODE === 'Backslash' ? '「、」' : KEY_CODE;
  console.log(`[字幕快捷键] v${VERSION} 第 ${gen} 代 已就绪：按 ${label} 开/关字幕`);
})();
