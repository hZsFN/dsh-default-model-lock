import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, '.sandbox');
const home = path.join(root, 'home');
const profile = path.join(home, 'profiles', 'plugintest');
const work = path.join(root, 'workspace');
const install = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), 'DeepSeek Harness');
const exe = path.join(install, 'DeepSeek Harness.exe');
const cli = path.join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
const mode = process.argv[2] || 'help';
const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.some(k => k.toLowerCase() === key.toLowerCase())));
Object.assign(env, { DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' });
const args = ['--expose-internals', cli, '--profile', 'plugintest'];
if (mode === 'help') {
  console.log('用法: node scripts/isolation-probe.mjs prepare | app-help | start\nprepare 仅创建新 .sandbox，拒绝覆盖；app-help 仅显示 Web 帮助；start 前台启动 127.0.0.1:3199。\n不运行 pnpm、不读取生产配置、不继承凭证/代理/DSH 环境变量；仅从 Desktop 安装解析核心依赖。');
} else if (mode === 'prepare') {
  if (fs.existsSync(root)) throw new Error('隔离目录已存在，拒绝覆盖: ' + root);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-model-lock'];
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-model-lock-isolation', private: true, version: '1.0.0', dependencies: { 'dsh-model-lock': 'link:' + project.replaceAll('\\', '/') }, dsh: { profile: { bundles } } }, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', { flag: 'wx' });
  fs.mkdirSync(path.join(profile, 'node_modules'));
  fs.symlinkSync(project, path.join(profile, 'node_modules', 'dsh-model-lock'), 'junction');
  console.log(JSON.stringify({ home, profile, work, port: 3199, executable: exe, cli }, null, 2));
} else if (mode === 'app-help' || mode === 'start') {
  if (!fs.existsSync(path.join(profile, 'package.json'))) throw new Error('先运行 prepare');
  if (mode === 'app-help') {
    const result = spawnSync(exe, [...args, '--help'], { cwd: work, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(3199, '127.0.0.1', () => server.close(resolve)); });
    const child = spawn(exe, [...args, '--host', '127.0.0.1', '--port', '3199', '--no-open'], { cwd: work, env, stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    process.on('SIGINT', () => child.kill());
    process.on('SIGTERM', () => child.kill());
  }
} else throw new Error('未知模式: ' + mode);
