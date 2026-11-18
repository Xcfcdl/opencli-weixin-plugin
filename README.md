# opencli-weixin-plugin

OpenCLI 微信公众号插件：账号管理 + 草稿创建（图文 + 小绿书）。

## 安装

```bash
# 前提：已装 OpenCLI（npm i -g @jackwener/opencli），Chrome 已连 OpenCLI 扩展
git clone https://github.com/Xcfcdl/opencli-weixin-plugin.git
cd opencli-weixin-plugin
node install.mjs
```

安装后自动复制到 `~/.opencli/clis/weixin/`，OpenCLI 启动时扫描该目录自动发现。

## 命令

| 命令 | 说明 |
|---|---|
| `weixin accounts` | 列出所有已登录账号（公众号 + 小程序），`●` 标记当前活跃 |
| `weixin switch-account <name>` | 切换当前活跃账号（nickname 或 gh_xxx） |
| `weixin create-article ./post.md --title "..."` | 图文草稿（HTTP 接口，正文可带图，支持 Markdown） |
| `weixin create-newspic --title "..." --images ./a.jpg,./b.jpg` | 小绿书草稿（1–20 张图） |

上游原版 `weixin create-draft`（DOM 模拟）继续可用，本插件不覆盖。

## 账号切换流程

```bash
# 1. 查可用账号
opencli weixin accounts

# 2. 切换
opencli weixin switch-account "东立有话说"

# 3. 发草稿（自动用新账号的 token）
opencli weixin create-newspic "描述" --title "标题" --images ./a.jpg
```

## 测试

```bash
npm install
npm test    # 47 个 mock 测试，不碰真实微信
```

## 限制

- 图文：标题 ≤64 字，摘要 ≤120 字，单张图 ≤6 MB（建议 2 MB 以内）
- 小绿书：1–20 张图，描述 ≤1000 字，首张即封面
- 正文不能插 `mp.weixin.qq.com` 域名的链接（微信 `ret=64561`）
- 只建草稿，不发布；发布永远人工去后台点

## 文件

| 文件 | 说明 |
|---|---|
| `clis/weixin/accounts.js` | 账号列表（HTTP 接口 + 当前账号匹配） |
| `clis/weixin/switch-account.js` | 账号切换（Vue 组件触发 + DOM 点击） |
| `clis/weixin/create-article.js` | 图文草稿（HTTP 接口，scene=8 + crop_multi） |
| `clis/weixin/create-newspic.js` | 小绿书草稿（HTTP 接口，scene=5 + 五开关） |
| `clis/weixin/*.test.js` | vitest 测试（mock 页面，不碰真实微信） |
| `install.mjs` | 安装 + 注册自检 |
| `first-run.mjs` | 新机器首次检查（干跑不碰微信） |
| `assets/` | 测试卡 3 张 + 示例 Markdown 文章 |
| `IMPLEMENTATION.md` | 完整实现文档（协议、设计、验证状态） |
