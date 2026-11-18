# 给 OpenCLI 补小绿书（图片消息）草稿创建：完整实现总结

日期：2026-11-18。任务来源：boss 要求给 OpenCLI 补一个“贴图草稿创建”（公众号小绿书），
完整实现，并总结成文档；之后迁移到装了 OpenCLI 的其他用户机器上。

## 一、结论先行

- **做完了**：新命令 `opencli weixin create-newspic`，单文件适配器
  `create-newspic.js`（约 600 行），加测试、安装脚本、两份文档。
- **能做什么**：标题 + 1–20 张图 + 描述 → 公众号后台草稿箱里的一条小绿书草稿
  （图片卡片形态，首张即封面）。只建草稿，不发布。
- **2026-11-18 晚又加了一个**：`opencli weixin create-article`（§九），用模拟请求路线
  建图文草稿，正文可带图——这是上游 `create-draft`（DOM 路线）做不到的。
  两个命令共用会话与上传逻辑，都是单文件适配器，走同一个 `install.mjs` 安装。
- **验证状态**：47 个 mock 测试全过（小绿书 21 + 图文 26）；在真实安装的
  OpenCLI 2.0.3 上验证了两个命令都能注册、`--help` 正常、能跑到浏览器连接那一步。
  **唯一没验证的是真机建草稿**：这台机器没有 Chrome、没有登录的公众号，
  微信侧的最后一步（传图 → 存草稿）只能在有登录会话的机器上实测。
  第一次在别的机器上跑时，务必先拿测试文件走一遍，确认草稿箱里的形态。
- **迁移成本**：两个文件 + 一条命令（`node install.mjs`），不用改上游 OpenCLI。

## 二、为什么是这个设计

### 2.1 路线选择：网页接口，不是官方 API

两条路都能建小绿书草稿：

|  | 网页接口（本次采用） | 官方 API（备选，未采用） |
|---|---|---|
| 凭证 | 复用浏览器登录会话，什么都不用配 | 要 AppID + AppSecret + IP 白名单 |
| 个人号 | 可用 | `draft/add` 在个人号上说法冲突，有人报 48001，须实测 |
| 与 OpenCLI 的契合度 | `create-draft` 本来就是浏览器自动化，同构 | 要另起一套凭证管理，迁移时每台机器都要配 |
| 风险 | 微信内部接口、无公开文档，参数可能变 | 官方接口稳定，但门槛高 |

迁移到“其他用户那边”是本次的硬要求：网页接口路线零配置，装上就能用；
官方 API 路线每个用户都要配 AppSecret 和白名单，迁移成本高得多。
所以主实现走网页接口，官方 API 只在文档里留作备选。

### 2.2 形态确认：小绿书 ≠ 图文正文插图

这是前期调研里纠正过的理解：

- 图文（`create-draft`）：标题 + HTML 正文，正文里可插图，封面另设。
  它的正文是 `execCommand('insertText')` 纯文本插入，所以“正文配图”原生不支持。
- 小绿书（`create-newspic`，图片消息 `newspic`）：1–20 张图 + 标题 + 一段
  纯文本描述（≤1000 字），没有正文，没有单张配文，首张即封面，3:4 竖版最佳。

两者在微信后台共用同一个保存接口 `operate_appmsg?sub=create&type=77`，
区别全在表单参数。上一轮调研已确认：**opencli 原生不支持小绿书**
（`create-draft.js` 全文 grep `newspic|article_type|image_info` 零命中）。

### 2.3 参考实现

协议不是猜的，来自两处互相印证的开源实现：

1. **dsh-wechat-mp-studio**（FuncWei）的 `xiaolvshu-web-api.md`：
   2026 年真机验证过的网页接口文档，含完整表单字段表、五个形态开关、
   `scene=5` 与 `scene=8` 的区别、200040 去重坑。
2. **MultiPost**（leaperone/MultiPost-Extension）的 `src/sync/dynamic/weixin.ts`：
   同一份表单的代码实现（上传 + 建草稿 + 跳编辑页），与文档逐字段一致。

另外核对过：WechatSync 只做图文（`scene=8`，无小绿书字段），
lan-skills 的 `md2wx.mjs newspic` 走官方 API（可作对照），
baoyu-post-to-wechat 是浏览器点“贴图”菜单的另一条路（最多 9 张）。

## 三、协议（实现依据）

### 3.1 上传图片

```
POST https://mp.weixin.qq.com/cgi-bin/filetransfer
  ?action=upload_material&f=json&scene=5&writetype=doublewrite&groupid=1
  &ticket_id=<userName>&ticket=<ticket>&svr_time=<秒>&token=<token>
  &lang=zh_CN&seq=<毫秒>&t=<随机数>
multipart/form-data: type, id, name, lastModifiedDate, size, file
```

- `scene=5` 是动态/小绿书场景；文章用 `scene=8`，传错拿不到 file_id。
- 返回 `{base_resp:{err_msg:"ok"}, cdn_url:"https://mmbiz.qpic.cn/...", content:"<fileid>"}`，
  `content` 就是 file_id，**必须转数字**再放进表单。
- `ticket` / `user_name` 的获取：先读公众号首页 HTML（`window.wx.commonData` 一带），
  拿不到就调消息列表 JSON（`cgi-bin/message?t=message/list` → `user_info.user_name` +
  `base_resp.media_ticket`）。两处都拿不到就报明确错误，不猜。

### 3.2 建草稿

```
POST https://mp.weixin.qq.com/cgi-bin/operate_appmsg
  ?t=ajax-response&sub=create&type=77&token=<token>&lang=zh_CN
Content-Type: application/x-www-form-urlencoded
```

关键字段（完整表单见代码 `buildNewspicForm`，此处只列决定形态的）：

| 字段 | 值 | 作用 |
|---|---|---|
| `title0` | ≤64 字 | 标题 |
| `content0` | ≤1000 字 | 描述正文 |
| `guide_words0` | 同 content0 | 描述的另一份拷贝 |
| `share_imageinfo0` | `{"list":[{url, file_id, width, height, theme_color, disable_theme:0, disable_live:0, cdn_url}]}` | 图片列表，file_id 数字，首张即封面 |
| `share_page_type0` | `"8"` | 有图 |
| `style_type0` | `"3"` | 小绿书样式开关 |
| `new_pic_process0` | `"1"` | 新图片流程 |
| `is_auto_type_setting` | `"3"` | 自动类型设置 |
| `save_type` | `"1"` | 保存为图片消息 |
| `isneedsave` | `"0"` | |

**五个开关缺一个都可能存成普通文章形态。** 返回 `{appMsgId}` 即保存成功；
形态对不对要去草稿箱看（图片卡片 vs 文章排版），接口返回值不告诉你。

### 3.3 官方 API 备选（未采用，留作对照）

```
token → material/add_material(type=image, 永久素材) → draft/add
{"articles":[{"article_type":"newspic","title":"...","content":"...",
  "need_open_comment":1,"only_fans_can_comment":0,
  "image_info":{"image_list":[{"image_media_id":"..."}]}}]}
```

要点：每张图先传**永久素材**（临时素材报 40007）；标题 ≤32 字（比网页接口的 64 字严）；
`thumb_media_id` 是图文专用的，小绿书不传，封面自动取首张；
`freepublish/submit` 自 2025-07 起仅认证企业号可用，个人号发草稿之后必须手动发表。
若将来网页接口失效、且用户愿意配 AppSecret，可按这个结构另起一个命令。

## 四、实现结构

文件都在 `~/workspace/opencli-weixin-newspic/`，迁移时只需要 `create-newspic.js`
与 `create-article.js` 两个文件（§九）。

### 4.1 `create-newspic.js`（适配器本体）

完全照着上游 `clis/weixin/create-draft.js` 的写法（同一套 `cli()` 注册、
同一套错误类型、同一套 `page.evaluate` 字符串脚本风格），新用户读起来零学习成本：

- **命令定义**：`site: weixin`，`name: create-newspic`，`access: write`，
  `strategy: Strategy.COOKIE`，`browser: true`，`navigateBefore: false`（自己 goto）。
- **参数**：`--title`（必填，≤64 字）；`content`（位置参数，描述，≤1000 字，可空）；
  `--images`（必填，逗号分隔，1–20 张）；`--tags`（可选，追加 `#标签`）；
  `--dry-run`（只校验不碰微信）；`--timeout`（默认 300 秒，20 张图上传要留够时间）。
- **主流程**（`func`）：
  1. 校验标题 / 描述 / 图片（本地，不碰浏览器）。
  2. `--dry-run` 时直接返回，不登录不上传。
  3. `page.goto(mp.weixin.qq.com)`，从地址栏取 token，拿不到 → `AuthRequiredError`（请登录）。
  4. 取上传凭证 ticket / user_name（首页 HTML → 消息列表 JSON，两级 fallback）。
  5. 逐张上传：图片 base64 传进页面，在页面里还原成 `File` → `FormData` →
     `fetch(filetransfer, scene=5)`，逐张拿回数字 file_id + cdn_url。
  6. 在 Node 里拼好 `operate_appmsg` 完整表单，用 `page.evaluateOnce` 一次性 POST
     （创建调用非幂等，不能走 `evaluate` 的导航重试，否则可能建出重复草稿）。
  7. 返回 `{status: 'draft saved', detail: '"标题" (N images) — draft <id>, edit: <编辑页 URL>'}`。
- **纯函数**（可不依赖浏览器单测，都已 export）：`resolveImages`（校验 + 读尺寸 +
  base64）、`readImageDimensions`（PNG/JPEG/GIF/WebP 文件头解析，不引解码库）、
  `parseSessionFromHtml` / `parseSessionFromMessageList`、`buildFiletransferUrl`、
  `buildShareImageInfo`、`buildNewspicForm`、`parseSaveResponse`。

### 4.2 几个有意识的决定

- **单张图 6 MB 上限**：`evaluate` 里传 base64 有体积限制（上游 `setFileInput` 的注释
  明确写了这一点，Chrome 直接读本地文件才能绕开）。6 MB 是保守值；
  另有文档建议 2 MB 以内最稳（大图容易卡审核）。将来若要支持更大图，
  改走 `page.getCookies()` + Node 侧 fetch（见 §七）。
- **不静默截断**：标题超 64 字、描述超 1000 字直接报错，不替用户截断丢字。
- **图片尺寸在 Node 侧解析**：不依赖页面里的 `Image` 加载，纯函数可测；
  读不到尺寸的图片直接报错，不带未知尺寸上传。
- **200040 特殊处理**：微信的重复提交频控只看标题 + 描述、跟图片无关，
  且等 8 小时也不解除；报错信息直接告诉用户“改措辞再推，别等”。
- **只建草稿**：没有发布参数，没有定时群发入口。发布、群发永远人工。

### 4.3 其他文件

| 文件 | 用途 |
|---|---|
| `create-newspic.js` | 小绿书适配器本体（迁移文件之一） |
| `create-newspic.test.js` | vitest，21 个测试，mock 页面，不碰真实微信 |
| `create-article.js` | 图文适配器本体（迁移文件之一，§九） |
| `create-article.test.js` | vitest，26 个测试，mock 页面，不碰真实微信 |
| `install.mjs` | 复制两个适配器到 `~/.opencli/clis/weixin/` + 各跑 `--help` 验证注册 |
| `first-run.mjs` | 新机器首次检查：安装 + 两条命令各干跑一次（不碰微信） |
| `assets/test-card-*.png` | 测试卡 3 张（1080×1440，3:4），只用来验证安装 |
| `assets/sample-article.md` | 图文示例文章（带一张插图），只用来验证安装 |
| `CHANGELOG.md` | 版本记录 |
| `package.json` | 仅用于本地跑测试（vitest + opencli 开发依赖） |
| `README.md` | 用法、限制、常见报错 |
| `IMPLEMENTATION.md` | 本文件 |

## 五、验证情况（诚实版）

### 已验证（2026-11-18，本机）

1. **语法**：`node --check` 全部文件通过。
2. **单元测试**：`npm test` —— 47/47 通过（小绿书 21 + 图文 26）。小绿书覆盖见原列表；
   图文新增覆盖：Markdown 转 HTML（标题/段落/列表/引用/代码围栏/行内格式）、
   居中裁剪配置（与 MultiPost 模板数值的逐项对照，见 §九）、封面表单字段
   （cdn 系列 + crop_list0、无小绿书开关）、完整流程（正文图 + 封面 → `draft saved`）、
   无封面时不调 crop_multi、HTML 文件原样过、干跑不调浏览器、无 token 报错、
   首页无 ticket 走消息列表 fallback、上传失败、封面裁剪失败、200040、参数校验
   （文件不存在、后缀不对、标题超 64 字、正文图超 6 MB）。
3. **真实 OpenCLI 安装上的注册**：在隔离 HOME 里装了 OpenCLI 2.0.3（npm 官方包），
   跑 `node install.mjs`，两个文件落到 `~/.opencli/clis/weixin/`，
   `opencli weixin create-newspic --help` 与 `opencli weixin create-article --help`
   都正确显示命令与全部参数。
   说明私有适配器扫描机制（`~/.opencli/clis/` 目录扫描，无 manifest 时走文件系统发现）
   如预期工作，迁移路径是通的。
4. **真实调用的接线**：不带登录跑真命令，返回 `BROWSER_CONNECT`（这台机器没有
   Chrome、没有 OpenCLI 扩展）。这是环境缺失，不是代码问题；它证明命令已分发到
   浏览器运行时。另外发现：`--dry-run` 同样先报 `BROWSER_CONNECT`——OpenCLI
   在调 `func` 之前就先连浏览器，干跑省的是“登录公众号 + 上传 + 建草稿”，
   不是“连浏览器”。README 已按这个实测结果写明。

### 未验证（需要有登录会话的机器）

- **真机建草稿**：传图 → 存草稿 → 草稿箱里确认是图片卡片形态。
  协议来自两处互相印证的开源实现，可信度较高，但微信内部接口随时可能变，
  第一次在别的机器上跑必须实测。
- **首页 HTML 里的 ticket 字段名**：`ticket` / `user_name` 的正则取自通用模式，
  若微信改了首页结构，第一级会失败并自动走消息列表 fallback；两级都失败时会报
  明确错误，不会静默建错。
- **大图（>2 MB）上传**：文档建议 2 MB 以内最稳，未实测过大图。
- **`--dry-run` 在有浏览器但未登录公众号的机器上的表现**：按代码应直接返回
  `dry-run ok`，未实测。

## 六、迁移步骤（给以后）

1. 把整个目录带到目标机器（迁移文件是 `create-newspic.js` 与 `create-article.js` 两个）。
2. 目标机器装好 OpenCLI（`npm i -g @jackwener/opencli`），Chrome 打开并连上 OpenCLI 扩展，
   浏览器里登录好 mp.weixin.qq.com。
3. 在包目录跑 `node first-run.mjs`：装适配器、自检注册、两条命令各干跑一遍（不碰微信）。
4. 按提示真推两条测试草稿，去草稿箱确认形态：小绿书是图片卡片形态，图文是文章排版
   （正文里有插图、封面已设）。确认完删掉测试草稿。
5. 若上游 OpenCLI 将来出了同名命令，本地文件会盖掉它；届时删文件 + `opencli adapter reset weixin`。

## 七、已知限制与后续可做的事

- **单张 6 MB 上限**（base64-in-evaluate 的体积限制）：大图先压缩；若用户常推大图，
  改走 `page.getCookies()` 拿会话 cookie + Node 侧 `fetch` 上传，绕开 evaluate 传参。
- **网页接口无公开文档**：微信一改版就可能失效。失效时先按 dsh 文档 §四的办法
  （Sourcegraph 搜 `operate_appmsg`、对照 MultiPost 的 `weixin.ts`、用真实草稿箱验形态）
  重新核对表单，再改 `buildNewspicForm`。
- **官方 API 路线未实现**：若某天用户愿意配 AppSecret 且网页接口失效，
  按 §3.3 的结构另起一个命令（`add_material` → `draft/add`），约 100 行。
- **图片裁剪**：目前不裁剪，原图直传；3:4 竖图效果最好，用户自己在后台也可二次裁剪。
- **每图配文**：小绿书本身不支持单张配文，只有全篇一段描述——这是产品形态限制，不是本命令的缺失。

## 八、来源

- 协议文档：`~/workspace/projects/overseas-monetization/opencli-weixin-draft-research.md`
  （图文草稿调研）与 `~/workspace/projects/overseas-monetization/wechat-xiaolvshu-newspic-research.md`
  （小绿书调研：官方 API + 网页接口 + 各工具支持情况）。
- 上游 OpenCLI 2.0.3：`clis/weixin/create-draft.js`（结构模板）、
  `src/discovery.ts`（私有适配器发现机制）、`src/browser/page.ts`
  （`evaluate` / `evaluateOnce` / `setFileInput` 的约束）。
- 参考实现：dsh-wechat-mp-studio `xiaolvshu-web-api.md`；MultiPost `src/sync/dynamic/weixin.ts`。

## 九、新增：图文 create-article（模拟请求路线，2026-11-18 晚）

### 9.1 为什么再补一个图文命令

上游 `create-draft` 已经能建图文草稿，但它走 DOM 操作：打开编辑器、
正文 `execCommand('insertText')` 纯文本插入、封面走文件上传框点保存。
所以它的正文**配不了图**——这是调研里确认过的原生限制。

boss 当晚问：有没有也是模拟请求路线的图文？有。查完两处开源实现就补了
`create-article.js`：同一个保存接口、同一套会话与上传逻辑（与
create-newspic 共用 `getUploadSession` / base64 传图的手法），
区别只在表单与场景值。它和 `create-draft` 不是替代关系，是互补：
`create-draft` 是上游自带的 DOM 路线，`create-article` 是我们补的请求路线，
后者多出来的能力就是**正文带图 + 封面裁剪一次到位**。

### 9.2 参考实现

1. **WechatSync**（wechatsync/Wechatsync）的
   `packages/core/src/adapters/platforms/weixin.ts`（v2）：
   `operate_appmsg sub=create&type=77` + `filetransfer scene=8`，
   `content0` 直接放处理好的 HTML（图先传上去换 mmbiz 地址再拼进去），
   封面字段全空也能存草稿。
2. **MultiPost**（leaperone/MultiPost-Extension）的 `src/sync/article/weixin.ts`：
   同一接口，补齐了封面部分——`cropimage?action=crop_multi` 按
   16:9 / 1:1 / 3:4 裁剪 + `cdn_url0` 系列 + `crop_list0` 的完整表单。
   另有 `uploadimg2cdn`（远程图直转 CDN）作为正文图上传的另一条路，
   本命令 v1 没用它（见 9.5）。

### 9.3 协议（实现依据）

三步，与小绿书同构，只差场景值与表单：

```
1. 正文图（本地）：POST cgi-bin/filetransfer?action=upload_material&scene=8 …
   → {cdn_url, content: file_id}，把 cdn_url 换进 content0 的 <img src> 里。
2. 封面（若给了 --cover-image）：
   a. 先传 scene=8，拿 cdn_url；
   b. POST cgi-bin/cropimage?action=crop_multi
      form: imgurl=<封面 cdn_url>, size_count=3,
            size0_x1/y1/x2/y2（16:9 居中裁剪框，比例坐标）,
            size1_…（1:1）, size2_…（3:4）, token, lang, f=json, ajax=1
      → {base_resp:{err_msg:"ok"}, result:[{cdnurl, file_id, height, width} × 3]}
      （顺序与请求的 size 顺序一致）。
3. POST cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77 …
   content0 = 带图的完整 HTML。
```

封面字段（MultiPost 的做法）：`cdn_url0` 与 `cdn_235_1_url0` 填 1:1 裁剪图
（2.35:1 的位置也填它，因为裁剪只做了三种比例）；`cdn_16_9_url0` /
`cdn_3_4_url0` / `cdn_1_1_url0` 各填对应比例；`cdn_url_back0` 填 1:1；
`crop_list0` = `{"crop_list":[{ratio:"16_9",x1,y1,x2,y2,file_id}…],
"crop_list_percent":[{ratio:"16_9",x1,y1,x2,y2,file_id}…]}`，
像素坐标与比例坐标各一份。裁剪框是**居中裁剪**（`calculateCropConfig`，
与 MultiPost 的算法逐行一致）：图太宽切两边，图太高切上下。
`fileid0` 留空（两份实现都留空），`share_page_type0="0"`，
`share_imageinfo0='{"list":[]}'`，**不带小绿书那五个开关**。

### 9.4 实现结构

- **输入**：位置参数 `file`，`.md` 或 `.html`。`.md` 走自带的 Markdown 子集转换
  （标题 `#`–`###`、段落、列表、引用、分割线、代码围栏、行内图片/链接/粗体/斜体/代码；
  表格、脚注、嵌套列表不支持，要复杂排版请直接传 `.html`）。
  `--title`（必填，≤64 字）、`--author`、`--digest`（≤120 字，不给自动生成，
  `auto_gen_digest0=1`）、`--cover-image`（可选）、`--dry-run`、`--timeout`（默认 300 秒）。
- **正文图**：从源码里收集图片地址（Markdown 读 `![](src)`，HTML 读 `<img src>`），
  去重；本地路径按文章文件所在目录解析，逐一校验（格式、6 MB 上限、读尺寸），
  逐张 `scene=8` 上传后把 `src="…"` 换成 `src="<cdn_url>"`。远程地址与 data: 地址
  原样保留，不上传。
- **封面**：有则走上传 → `crop_multi` → `buildCropList` → 填表；无则封面字段全空
  （WechatSync 的做法，不带封面也能存草稿）。
- **保存**：与小绿书一样，表单在 Node 里拼好，`page.evaluateOnce` 一次性 POST，
  返回 `{appMsgId}` 即成功，附编辑页 URL。200040 同样特殊处理（改措辞再推）。
- **纯函数**（已 export，可单测）：`markdownToHtml`、`escapeHtml`、
  `collectImageSources`、`resolveContentImages`、`resolveCoverImage`、
  `calculateCropConfig`、`buildCropList`、`parseCropResponse`、
  `buildFiletransferUrl`（scene 参数化）、`buildArticleForm`、`parseSaveResponse`、
  以及与小绿书同款的 `readImageDimensions`、`parseSessionFromHtml` /
  `parseSessionFromMessageList`。

### 9.5 已知限制（图文特有）

- **远程正文图不上传**：`![](https://…)` 原样留在 HTML 里，微信后台未必接受外链图。
  WechatSync 是把远程图下载下来再传 `filetransfer`，MultiPost 是先试
  `uploadimg2cdn` 再回落到 `filetransfer`。v1 没做这两条，因为页面内 fetch
  远程图可能撞 CORS；常用的是本地图，先够用。将来要支持再按这两份实现补。
- **封面裁剪是服务端裁**：`crop_multi` 一次返回三种比例的图，各自有独立 file_id；
  本命令直接用它返回的结果填表，不在本地裁图。
- **裁剪框的浮点噪声**：1178×1570 的原图按 3:4 切，`x1` 不是精确的 0 而是
  `0.0002122…`（宽高比 0.7503… 比 0.75 大一点点）——这是 MultiPost 模板里那个
  `2.12e-20` 怪数字的来源，公式原样复现，测试里已逐项对照。
- **其余限制与小绿书相同**：单张 6 MB 上限（base64-in-evaluate）、只建草稿不发布、
  真机建草稿未验证（见 §五）。
