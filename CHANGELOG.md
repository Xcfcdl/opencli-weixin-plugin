# Changelog

## 1.1.0 — 2026-11-18

- 新增 `opencli weixin create-article`：用模拟请求路线建图文草稿，正文可带图——上游 `create-draft`（DOM 路线，正文纯文本插入）做不到的由它补上。
- 路线：网页接口（filetransfer `scene=8` 传正文图与封面 → cropimage `crop_multi` 按 16:9 / 1:1 / 3:4 居中裁剪封面 → operate_appmsg 存草稿，`content0` 为带图 HTML），复用浏览器登录会话，个人号可用，零配置。
- 输入：Markdown（`.md`，自带子集转换：标题/段落/列表/引用/代码围栏/行内格式）或 HTML（`.html`，原样过）；正文本地图自动上传换 mmbiz 地址，远程地址原样保留；`--author`、`--digest`（≤120 字，不给自动生成）、`--cover-image`（可选，不给不设封面）。
- 表单：WechatSync + MultiPost 图文实现并集，不带小绿书五个开关；`fileid0` 留空；200040 去重错误提示改措辞再推；创建调用走 `evaluateOnce` 防重复建草稿。
- 测试：`create-article.test.js`，26 个 mock 测试全过（不碰真实微信），全包 47 个；裁剪配置与 MultiPost 模板数值逐项对照。
- 迁移：`install.mjs` 现在装两个命令并各自验证注册；`first-run.mjs` 改为四步（两条命令各干跑一次）；新增 `assets/sample-article.md` 示例文章。

已知未验证：真机建图文草稿（需有登录会话的机器首次实测，见 IMPLEMENTATION.md §五、§九）。

## 1.0.0 — 2026-11-18

首个完整版，随压缩包第一次迁移。

- 新增 `opencli weixin create-newspic`：标题 + 1–20 张图 + 描述 → 公众号小绿书（图片消息）草稿，只建草稿，不发布。
- 路线：网页接口（filetransfer `scene=5` 传图 → operate_appmsg 五开关存草稿），复用浏览器登录会话，个人号可用，零配置。
- 参数校验：标题 ≤64 字、描述 ≤1000 字、单张图 ≤6 MB（建议 2 MB 以内），超限直接报错不截断；`--dry-run` 只校验不碰微信；`--tags` 追加 `#标签`。
- 错误处理：无登录报 `AuthRequiredError`；200040 去重错误提示改措辞再推；创建调用走 `evaluateOnce` 防重复建草稿。
- 测试：`create-newspic.test.js`，21 个 mock 测试全过（不碰真实微信）。
- 迁移：`install.mjs` 一键安装到 `~/.opencli/clis/weixin/` 并自检注册。
- 首次检查：`first-run.mjs`（装适配器 + 用自带测试卡干跑）与 `assets/` 测试卡 3 张（1080×1440，3:4）。
- 文档：`README.md`（用法与报错）、`IMPLEMENTATION.md`（完整实现总结）。

已知未验证：真机建草稿（需有登录会话的机器首次实测，见 IMPLEMENTATION.md §五）。
