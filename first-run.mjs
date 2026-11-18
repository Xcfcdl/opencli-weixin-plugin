#!/usr/bin/env node
/**
 * 首次运行检查（目标机器上解压后跑一次）：
 *   node first-run.mjs
 *
 * 依次做五件事，全都不碰微信：
 *   1. 确认 opencli 已装；
 *   2. 跑 install.mjs（装 4 个适配器 + 验证注册）；
 *   3. 用自带测试卡跑 create-newspic --dry-run；
 *   4. 用自带示例文章跑 create-article --dry-run；
 *   5. 确认 accounts 命令可用（不跑，只 --help）。
 * 通过之后，再按屏幕提示真推测试草稿。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cards = [1, 2, 3]
    .map((i) => path.join(dir, 'assets', `test-card-${i}-1080x1440.png`))
    .join(',');

function run(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, spawnError: result.error || null };
}

function dryRun(command, args, label) {
    const result = run('opencli', args);
    if (result.output.includes('BROWSER_CONNECT')) {
        console.error(`${label}没跑起来：浏览器扩展没连上。`);
        console.error('请先打开 Chrome、连好 OpenCLI 扩展（不需要登录公众号），再跑一次：node first-run.mjs');
        process.exit(1);
    }
    if (result.code !== 0 || !result.output.includes('dry-run ok')) {
        console.error(`${label}失败，输出如下：`);
        console.error(result.output.slice(0, 2000));
        process.exit(1);
    }
    console.log(`${label}通过。`);
}

console.log('[1/5] 检查 opencli …');
const version = run('opencli', ['--version']);
if (version.spawnError || version.code !== 0) {
    console.error('没找到 opencli。先装：npm i -g @jackwener/opencli，再跑一次本脚本。');
    process.exit(1);
}
console.log(`opencli 已装：${version.output.trim()}`);

console.log('[2/5] 安装适配器 …');
const install = spawnSync('node', [path.join(dir, 'install.mjs')], { encoding: 'utf8', stdio: 'inherit' });
if (install.status !== 0) {
    console.error('安装失败，见上面输出。');
    process.exit(1);
}

console.log('[3/5] 小绿书干跑（不碰微信）…');
dryRun('create-newspic', [
    'weixin', 'create-newspic',
    '安装测试描述',
    '--title', '小绿书安装测试',
    '--images', cards,
    '--dry-run',
], '小绿书干跑');

console.log('[4/5] 图文干跑（不碰微信）…');
dryRun('create-article', [
    'weixin', 'create-article',
    path.join(dir, 'assets', 'sample-article.md'),
    '--title', '图文安装测试',
    '--cover-image', path.join(dir, 'assets', 'test-card-2-1080x1440.png'),
    '--dry-run',
], '图文干跑');

console.log('[5/5] accounts / switch-account 注册确认 …');
const accountsHelp = run('opencli', ['weixin', 'accounts', '--help']);
if (accountsHelp.code !== 0) {
    console.error('accounts 命令注册失败：');
    console.error(accountsHelp.output.slice(0, 500));
    process.exit(1);
}
const switchHelp = run('opencli', ['weixin', 'switch-account', '--help']);
if (switchHelp.code !== 0) {
    console.error('switch-account 命令注册失败：');
    console.error(switchHelp.output.slice(0, 500));
    process.exit(1);
}
console.log('accounts + switch-account 注册通过。');

console.log('');
console.log('全部通过：4 个命令都注册成功，什么都没发到微信。');
console.log('');
console.log('下一步（真推测试草稿）：');
console.log('  1. 浏览器里登录 mp.weixin.qq.com；');
console.log('  2. opencli weixin accounts          # 确认账号列表');
console.log('  3. opencli weixin switch-account "目标账号"  # 切换到目标账号（可选）');
console.log(`  4. opencli weixin create-newspic "安装测试描述" --title "小绿书安装测试" --images ${cards}`);
console.log(`  5. opencli weixin create-article ${path.join(dir, 'assets', 'sample-article.md')} --title "图文安装测试" --cover-image ${path.join(dir, 'assets', 'test-card-2-1080x1440.png')}`);
console.log('  6. 去公众号后台草稿箱确认形态，确认完删掉测试草稿。');
