#!/usr/bin/env node
/**
 * 安装 opencli weixin 适配器（create-newspic + create-article + accounts + switch-account）。
 *
 * 用法（在本目录运行）：
 *   node install.mjs            # 装到当前用户的 ~/.opencli/clis/weixin/
 *   node install.mjs --check    # 只检查是否已注册，不复制
 *
 * 原理：OpenCLI 启动时扫描 ~/.opencli/clis/<site>/*.js，文件里调用了 cli()
 * 就会被自动发现注册，不用改上游、不用重新构建，升级 OpenCLI 也不会丢
 * （除非上游将来出了同名命令，那时以这里的为准，会盖掉官方版本——
 * 若发生这种情况，删掉本文件再跑 `opencli adapter reset weixin`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADAPTER_FILES = ['create-newspic.js', 'create-article.js', 'accounts.js', 'switch-account.js'];
const SITE_DIR = path.join(os.homedir(), '.opencli', 'clis', 'weixin');

function runOpencli(args) {
    return spawnSync('opencli', args, { encoding: 'utf8' });
}

function checkRegistered(command) {
    const result = runOpencli(['weixin', command, '--help']);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return { ok: output.includes(command), output, code: result.status };
}

const onlyCheck = process.argv.includes('--check');
const dir = path.dirname(fileURLToPath(import.meta.url));

if (!onlyCheck) {
    for (const file of ADAPTER_FILES) {
        const source = path.join(dir, 'clis', 'weixin', file);
        if (!fs.existsSync(source)) {
            console.error(`找不到适配器文件: ${source}`);
            process.exit(1);
        }
        fs.mkdirSync(SITE_DIR, { recursive: true });
        fs.copyFileSync(source, path.join(SITE_DIR, file));
        console.log(`已安装: ${path.join(SITE_DIR, file)}`);
    }
}

let allOk = true;
for (const file of ADAPTER_FILES) {
    const command = file.replace(/\.js$/, '');
    const check = checkRegistered(command);
    if (check.ok) {
        console.log(`注册成功：opencli weixin ${command} 已可用。`);
    } else {
        allOk = false;
        console.error(`未检测到命令注册：opencli weixin ${command}。可能原因：`);
        console.error('  1. opencli 不在 PATH（先装 OpenCLI：npm i -g @jackwener/opencli）；');
        console.error('  2. 本次运行的 opencli 读的是另一套用户目录（检查 HOME / --help 输出）。');
        console.error('--- opencli weixin ' + command + ' --help 输出（节选）---');
        console.error(check.output.slice(0, 2000));
    }
}

if (allOk) {
    console.log('');
    console.log('先确认浏览器已登录 mp.weixin.qq.com，然后试：');
    console.log('  opencli weixin accounts');
    console.log('  opencli weixin switch-account "东立有话说"');
    console.log('  opencli weixin create-newspic "描述" --title "测试" --images ./a.jpg --dry-run');
    console.log('  opencli weixin create-article ./post.md --title "测试" --dry-run');
    process.exit(0);
}
process.exit(1);
