/**
 * stop.js —— 停止后台的启动器进程
 *
 * 从「启动.vbs」隐藏启动之后没有窗口可关，必须给一个明确的停止入口。
 * 读取 launcher 留下的 pid 记录，把那个进程结束掉。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, '..', '配置', '运行状态.json');

function main() {
  console.log('\n=== B站字幕快捷键 · 停止 ===\n');

  let pid = null;
  try {
    pid = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid;
  } catch { /* 没有记录，正常 */ }

  if (!pid) {
    console.log('· 没有正在运行的实例。\n');
    return;
  }

  let alive = true;
  try {
    process.kill(pid, 0);          // 不抛异常 = 还活着
  } catch {
    alive = false;
  }

  if (!alive) {
    console.log(`· 进程 ${pid} 已经不在运行了，清掉陈旧的记录。\n`);
    try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }
    return;
  }

  console.log(`· 正在停止（进程 ${pid}）...`);
  try {
    process.kill(pid);
  } catch (err) {
    console.error(`✗ 停止失败：${err.message}`);
    console.error('  可以打开任务管理器，手动结束 node.exe。\n');
    process.exitCode = 1;
    return;
  }

  try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }

  console.log('✓ 已停止。快捷键不再生效，B站客户端本身不受影响。\n');
}

main();
