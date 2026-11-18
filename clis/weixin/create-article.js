/**
 * weixin create-article — 用模拟请求路线创建微信公众号图文草稿。
 *
 * OpenCLI 上游的 weixin create-draft 走 DOM 操作：打开编辑器、往正文
 * insertText 纯文本、封面走文件上传框点保存。所以正文配图做不了，
 * 内容只能是纯文本。
 *
 * 本文件走另一条路线：直接调微信后台的网页接口（与小绿书 create-newspic
 * 同一套会话与上传逻辑），只建草稿，不发布：
 *   1. 正文里的本地图，一张张 POST cgi-bin/filetransfer
 *      ?action=upload_material&scene=8 …（scene=8 是文章场景，小绿书用 5）
 *      → 拿 cdn_url，换进正文 HTML 的 <img src> 里。
 *   2. 封面（若给了 --cover-image）：先传 scene=8，再调
 *      cgi-bin/cropimage?action=crop_multi，按 16:9 / 1:1 / 3:4 三种比例
 *      居中裁剪（服务端裁），拿到每种比例的 cdnurl + file_id。
 *   3. POST cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77 …，
 *      表单里 content0 是带图的完整 HTML，封面字段填裁剪结果。
 *   只建草稿，不发布。发布永远由人在公众号后台点。
 *
 * 协议来源：WechatSync 的 packages/core/src/adapters/platforms/weixin.ts
 * （v2，operate_appmsg + filetransfer scene=8，content0 直接放 HTML）
 * 与 MultiPost 的 src/sync/article/weixin.ts（同一接口，补齐了封面裁剪
 * crop_multi + crop_list0 的完整表单）。两处实现互相印证。
 * 网页接口是微信内部接口、无公开文档，参数随时可能变；若某天失效，
 * 先按 IMPLEMENTATION.md 的办法重新核对表单再改本文件。
 *
 * 安装（可迁移到任何装了 OpenCLI 的机器）：
 *   把本文件复制到 ~/.opencli/clis/weixin/create-article.js 即可，
 *   OpenCLI 启动时会扫描该目录自动发现（见同目录 install.mjs）。
 * 用法：
 *   opencli weixin create-article ./post.md --title "标题" --cover-image ./cover.jpg
 *   opencli weixin create-article ./post.html --title "标题" --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';

const WEIXIN_DOMAIN = 'mp.weixin.qq.com';
const WEIXIN_HOME = 'https://mp.weixin.qq.com/';
const FILETRANSFER_ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/filetransfer';
const CROPIMAGE_ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/cropimage';
const OPERATE_APPMSG_ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/operate_appmsg';
const EDIT_PAGE_BASE = 'https://mp.weixin.qq.com/cgi-bin/appmsg';

const MAX_TITLE_CHARS = 64;
const MAX_DIGEST_CHARS = 120;
/** 单张图上限：evaluate 里传 base64 有体积限制，超过就让用户先压缩。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** 封面裁剪的三种比例（与 MultiPost 的实现一致）。 */
const COVER_RATIOS = [
    { ratio: 16 / 9, label: '16_9' },
    { ratio: 1, label: '1_1' },
    { ratio: 3 / 4, label: '3_4' },
];

const IMAGE_MIME_TYPES = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
]);

function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === 'object' && typeof payload.session === 'string' && Object.hasOwn(payload, 'data')) {
        return payload.data;
    }
    return payload;
}

async function evaluate(page, script) {
    return unwrapEvaluateResult(await page.evaluate(script));
}

/** operate_appmsg 的创建调用是非幂等的：不能走 evaluate 的导航重试。 */
async function evaluateOnce(page, script) {
    if (typeof page.evaluateOnce === 'function') {
        return unwrapEvaluateResult(await page.evaluateOnce(script));
    }
    return evaluate(page, script);
}

// ---------------------------------------------------------------------------
// 纯函数：Markdown 转 HTML、图片尺寸、裁剪配置、表单构造 —— 不依赖浏览器，可直接单测。
// ---------------------------------------------------------------------------

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (match, alt, src) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        (match, label, href) => `<a href="${escapeHtml(href)}">${label}</a>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    return out;
}

/**
 * Markdown 子集转 HTML：标题 #–###、段落、列表（-/数字）、引用、分割线、
 * 代码围栏、行内图片/链接/粗体/斜体/代码。其余写法按纯文本处理。
 * 不支持表格、脚注、嵌套列表；要复杂排版请直接传 .html 文件。
 */
export function markdownToHtml(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) { i += 1; continue; }

        if (/^```/.test(line)) {
            const codeLines = [];
            i += 1;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i += 1; }
            i += 1;
            blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const level = Math.min(heading[1].length, 3);
            blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
            i += 1;
            continue;
        }

        if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
            blocks.push('<hr>');
            i += 1;
            continue;
        }

        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
            const quoteLines = [quote[1]];
            i += 1;
            while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i += 1; }
            blocks.push(`<blockquote><p>${quoteLines.map(renderInline).join('<br>')}</p></blockquote>`);
            continue;
        }

        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const unordered = /^\s*[-*]\s+/.test(line);
        if (ordered || unordered) {
            const items = [];
            while (i < lines.length) {
                const item = ordered
                    ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
                    : lines[i].match(/^\s*[-*]\s+(.*)$/);
                if (!item) break;
                items.push(item[1]);
                i += 1;
            }
            const tag = ordered ? 'ol' : 'ul';
            blocks.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
            continue;
        }

        const paraLines = [line];
        i += 1;
        while (i < lines.length && !/^\s*$/.test(lines[i])
            && !/^(#{1,6}\s|```|>\s?|[-*]\s|\d+[.)]\s|---+\s*$)/.test(lines[i])) {
            paraLines.push(lines[i]);
            i += 1;
        }
        blocks.push(`<p>${paraLines.map(renderInline).join('<br>')}</p>`);
    }
    return blocks.join('\n');
}

/** 从文件头读图片宽高（PNG / JPEG / GIF / WebP）。读不到返回 null。 */
export function readImageDimensions(buffer, extension) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    try {
        if (extension === '.png') {
            if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
            return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
        }
        if (extension === '.gif') {
            if (buffer.toString('ascii', 0, 6).slice(0, 3) !== 'GIF') return null;
            return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
        }
        if (extension === '.webp') {
            if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
            const chunk = buffer.toString('ascii', 12, 16);
            if (chunk === 'VP8X' && buffer.length >= 30) {
                return { width: (buffer.readUIntLE(24, 3) + 1), height: (buffer.readUIntLE(27, 3) + 1) };
            }
            if (chunk === 'VP8L' && buffer.length >= 25) {
                const bits = buffer.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
            }
            if (chunk === 'VP8 ' && buffer.length >= 30) {
                return { width: (buffer.readUInt16LE(26) & 0x3fff), height: (buffer.readUInt16LE(28) & 0x3fff) };
            }
            return null;
        }
        if (extension === '.jpg' || extension === '.jpeg') {
            if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
            let offset = 2;
            while (offset + 9 < buffer.length) {
                if (buffer[offset] !== 0xff) return null;
                const marker = buffer[offset + 1];
                if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    offset += 2;
                    continue;
                }
                const length = buffer.readUInt16BE(offset + 2);
                if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
                    return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
                }
                offset += 2 + length;
            }
            return null;
        }
    } catch {
        return null;
    }
    return null;
}

function loadImageFile(absPath, label) {
    let stat;
    try {
        stat = fs.statSync(absPath);
    } catch {
        throw new ArgumentError(`weixin create-article ${label} does not exist: ${absPath}`);
    }
    if (!stat.isFile()) {
        throw new ArgumentError(`weixin create-article ${label} is not a file: ${absPath}`);
    }
    const extension = path.extname(absPath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES.get(extension);
    if (!mimeType) {
        throw new ArgumentError(`weixin create-article ${label} must be JPEG, PNG, GIF, or WebP: ${absPath}`);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
        throw new ArgumentError(
            `weixin create-article ${label} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 6 MB limit; compress it first (under 2 MB is safest for review): ${absPath}`,
        );
    }
    const buffer = fs.readFileSync(absPath);
    const dimensions = readImageDimensions(buffer, extension);
    if (!dimensions || !dimensions.width || !dimensions.height) {
        throw new ArgumentError(`weixin create-article ${label} looks like an image but its size could not be read: ${absPath}`);
    }
    return {
        absPath,
        fileName: path.basename(absPath),
        mimeType,
        size: stat.size,
        width: dimensions.width,
        height: dimensions.height,
        base64: buffer.toString('base64'),
    };
}

/** 校验 --cover-image 的本地文件，返回含 base64 与宽高的图片。 */
export function resolveCoverImage(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    return loadImageFile(path.resolve(value), 'cover image');
}

/**
 * 收集正文里的图片地址：Markdown 读 ![](src)，HTML 读 <img src="...">。
 * 去重，保留出现顺序。
 */
export function collectImageSources(text, isMarkdown) {
    const srcs = [];
    const pattern = isMarkdown
        ? /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
        : /<img[^>]+src="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (!srcs.includes(match[1])) srcs.push(match[1]);
    }
    return srcs;
}

/**
 * 正文里的本地图（相对路径按 Markdown/HTML 文件所在目录解析），逐一校验，
 * 返回待上传列表。远程地址（http/https/协议相对）与 data: 地址原样保留，
 * 不上传——微信后台未必接受外链图，见 README。
 */
export function resolveContentImages(text, isMarkdown, baseDir) {
    const sources = collectImageSources(text, isMarkdown);
    const local = sources.filter((src) => !/^(https?:|data:|\/\/)/i.test(src));
    return local.map((src, index) => {
        const clean = decodeURIComponent(src.split('?')[0].split('#')[0]);
        const absPath = path.resolve(baseDir, clean);
        return { src, ...loadImageFile(absPath, `content image #${index + 1} (${src})`) };
    });
}

/** 从公众号首页 HTML 里取上传凭证（ticket / user_name）。 */
export function parseSessionFromHtml(html) {
    const text = String(html ?? '');
    const ticket = (text.match(/ticket\s*[:=]\s*["']([\w-]+)["']/) || [])[1] || '';
    const userName = (text.match(/user_name\s*[:=]\s*["']([\w-]+)["']/) || [])[1] || '';
    return { ticket, userName };
}

/** 备用：从消息列表 JSON 里取上传凭证（user_info.user_name + base_resp.media_ticket）。 */
export function parseSessionFromMessageList(payload) {
    const userName = payload?.user_info?.user_name || '';
    const ticket = payload?.base_resp?.media_ticket || '';
    return { ticket, userName };
}

/** filetransfer 上传地址：scene=8 是文章场景（小绿书用 5，传错拿不到 file_id）。 */
export function buildFiletransferUrl({ token, ticket, userName, scene = 8 }) {
    const url = new URL(FILETRANSFER_ENDPOINT);
    url.searchParams.set('action', 'upload_material');
    url.searchParams.set('f', 'json');
    url.searchParams.set('scene', String(scene));
    url.searchParams.set('writetype', 'doublewrite');
    url.searchParams.set('groupid', '1');
    url.searchParams.set('ticket_id', userName);
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('svr_time', String(Math.floor(Date.now() / 1000)));
    url.searchParams.set('token', token);
    url.searchParams.set('lang', 'zh_CN');
    url.searchParams.set('seq', String(Date.now()));
    url.searchParams.set('t', String(Math.random()));
    return url.toString();
}

/**
 * 居中裁剪配置（MultiPost calculateCropConfig 的同款算法）：按目标比例，
 * 在原图居中切一刀。返回比例坐标（crop_multi 与 crop_list_percent 用）
 * 与像素坐标（crop_list 用）。
 */
export function calculateCropConfig(ratio, width, height) {
    let x1;
    let y1;
    let x2;
    let y2;
    if (width / height > ratio) {
        const targetWidth = height * ratio;
        const cropPercent = (width - targetWidth) / 2 / width;
        x1 = cropPercent; y1 = 0; x2 = 1 - cropPercent; y2 = 1;
    } else {
        const targetHeight = width / ratio;
        const cropPercent = (height - targetHeight) / 2 / height;
        x1 = 0; y1 = cropPercent; x2 = 1; y2 = 1 - cropPercent;
    }
    return {
        x1, y1, x2, y2,
        x1_abs: Math.round(x1 * width),
        y1_abs: Math.round(y1 * height),
        x2_abs: Math.round(x2 * width),
        y2_abs: Math.round(y2 * height),
    };
}

/** crop_list0：三种比例的裁剪框（像素 + 比例两份）与各自裁剪图的 file_id。 */
export function buildCropList(crops) {
    return JSON.stringify({
        crop_list: crops.map((crop) => ({
            ratio: crop.ratioLabel,
            x1: crop.config.x1_abs,
            y1: crop.config.y1_abs,
            x2: crop.config.x2_abs,
            y2: crop.config.y2_abs,
            file_id: crop.fileId,
        })),
        crop_list_percent: crops.map((crop) => ({
            ratio: crop.ratioLabel,
            x1: crop.config.x1,
            y1: crop.config.y1,
            x2: crop.config.x2,
            y2: crop.config.y2,
            file_id: crop.fileId,
        })),
    });
}

/** 解析 crop_multi 的返回：按请求顺序返回三种比例的裁剪图（cdnurl + file_id）。 */
export function parseCropResponse(payload) {
    const result = payload?.result;
    if (payload?.base_resp?.err_msg === 'ok' && Array.isArray(result) && result.length > 0) {
        return result.map((item) => ({
            url: item.cdnurl,
            fileId: Number(item.file_id),
            width: item.width,
            height: item.height,
        }));
    }
    throw new CommandExecutionError(
        `WeChat cover crop failed (ret=${payload?.base_resp?.ret ?? 'n/a'}): ${payload?.base_resp?.err_msg || payload?.error || 'unknown error'}`,
    );
}

/**
 * operate_appmsg 的图文表单。字段集合是 WechatSync 与 MultiPost 两份
 * 图文实现并集：content0 是带图的完整 HTML；封面走 cdn_url0 系列 +
 * crop_list0（MultiPost 的做法）；没有封面时封面字段全空
 * （WechatSync 的做法，不带封面也能存草稿）。
 * 注意：不要带小绿书那五个开关（style_type0 / new_pic_process0 /
 * is_auto_type_setting / save_type / isneedsave），那是图片消息的形态开关。
 */
export function buildArticleForm({ token, title, author, digest, content, cover }) {
    const params = new URLSearchParams();
    const set = (key, value) => params.set(key, String(value));
    set('token', token);
    set('lang', 'zh_CN');
    set('f', 'json');
    set('ajax', '1');
    set('random', String(Math.random()));
    set('AppMsgId', '');
    set('count', '1');
    set('data_seq', '0');
    set('operate_from', 'Chrome');
    set('isnew', '0');
    set('ad_video_transition0', '');
    set('can_reward0', '0');
    set('related_video0', '');
    set('is_video_recommend0', '-1');
    set('title0', title);
    set('author0', author || '');
    set('writerid0', '0');
    set('fileid0', '');
    const cleanDigest = String(digest ?? '').trim();
    set('digest0', cleanDigest.slice(0, MAX_DIGEST_CHARS));
    set('auto_gen_digest0', cleanDigest ? '0' : '1');
    set('content0', content);
    set('sourceurl0', '');
    set('need_open_comment0', '1');
    set('only_fans_can_comment0', '0');
    if (cover) {
        const byRatio = new Map(cover.crops.map((crop) => [crop.ratioLabel, crop]));
        const oneToOne = byRatio.get('1_1');
        const sixteenNine = byRatio.get('16_9');
        const threeFour = byRatio.get('3_4');
        // MultiPost 的做法：默认封面取 1:1 裁剪图（2.35:1 的位置也填它）。
        set('cdn_url0', oneToOne?.url || '');
        set('cdn_235_1_url0', oneToOne?.url || '');
        set('cdn_16_9_url0', sixteenNine?.url || '');
        set('cdn_3_4_url0', threeFour?.url || '');
        set('cdn_1_1_url0', oneToOne?.url || '');
        set('cdn_url_back0', oneToOne?.url || '');
        set('crop_list0', cover.cropList);
    } else {
        set('cdn_url0', '');
        set('cdn_235_1_url0', '');
        set('cdn_16_9_url0', '');
        set('cdn_3_4_url0', '');
        set('cdn_1_1_url0', '');
        set('cdn_url_back0', '');
        set('crop_list0', '');
    }
    set('music_id0', '');
    set('video_id0', '');
    set('voteid0', '');
    set('voteismlt0', '');
    set('supervoteid0', '');
    set('cardid0', '');
    set('cardquantity0', '');
    set('cardlimit0', '');
    set('vid_type0', '');
    set('show_cover_pic0', '0');
    set('shortvideofileid0', '');
    set('copyright_type0', '0');
    set('releasefirst0', '');
    set('platform0', '');
    set('reprint_permit_type0', '');
    set('allow_reprint0', '');
    set('allow_reprint_modify0', '');
    set('original_article_type0', '');
    set('ori_white_list0', '');
    set('free_content0', '');
    set('fee0', '0');
    set('ad_id0', '');
    set('guide_words0', '');
    set('is_share_copyright0', '0');
    set('share_copyright_url0', '');
    set('source_article_type0', '');
    set('reprint_recommend_title0', '');
    set('reprint_recommend_content0', '');
    set('share_page_type0', '0');
    set('share_imageinfo0', '{"list":[]}');
    set('share_video_id0', '');
    set('dot0', '{}');
    set('share_voice_id0', '');
    set('insert_ad_mode0', '');
    set('categories_list0', '[]');
    set('compose_info0', '{"list":""}');
    return params.toString();
}

/** 解析 operate_appmsg 的返回：拿到 appMsgId 才算存草稿成功。 */
export function parseSaveResponse(payload) {
    const appMsgId = payload?.appMsgId;
    if (appMsgId) return String(appMsgId);
    const baseResp = payload?.base_resp ?? {};
    const ret = baseResp.ret;
    if (ret === 200040) {
        throw new CommandExecutionError(
            'WeChat rejected the draft as a duplicate (200040 保存受限). '
            + 'Reword the title or content and retry; waiting does not help.',
        );
    }
    const errMsg = baseResp.err_msg || payload?.err_msg || payload?.error || 'unknown error';
    throw new CommandExecutionError(`WeChat did not return a draft id (ret=${ret ?? 'n/a'}): ${errMsg}`);
}

// ---------------------------------------------------------------------------
// 浏览器内步骤（page.evaluate 里跑，自动带上登录会话的 cookie）。
// ---------------------------------------------------------------------------

async function getUploadSession(page, token) {
    const html = await evaluate(page, `(async () => {
        try {
            var response = await fetch('https://mp.weixin.qq.com/', { credentials: 'include' });
            return await response.text();
        } catch (error) { return ''; }
    })()`);
    let session = parseSessionFromHtml(html);
    if (session.ticket && session.userName) return session;

    const listed = await evaluate(page, `(async () => {
        try {
            var url = 'https://mp.weixin.qq.com/cgi-bin/message?t=message/list&count=1&day=0&token=${JSON.stringify(token)}&lang=zh_CN&f=json';
            var response = await fetch(url, { credentials: 'include' });
            return await response.json();
        } catch (error) { return null; }
    })()`);
    session = parseSessionFromMessageList(listed);
    if (session.ticket && session.userName) return session;
    throw new CommandExecutionError('Could not read the WeChat upload session (ticket). Please make sure you are logged in to mp.weixin.qq.com and retry.');
}

async function uploadImage(page, session, image, scene = 8) {
    const url = buildFiletransferUrl({ ...session, scene });
    const result = await evaluate(page, `(async () => {
        try {
            var binary = atob(${JSON.stringify(image.base64)});
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            var file = new File([bytes], ${JSON.stringify(image.fileName)}, { type: ${JSON.stringify(image.mimeType)} });
            var form = new FormData();
            form.append('type', ${JSON.stringify(image.mimeType)});
            form.append('id', String(Date.now()));
            form.append('name', ${JSON.stringify(image.fileName)});
            form.append('lastModifiedDate', new Date().toString());
            form.append('size', String(${image.size}));
            form.append('file', file);
            var response = await fetch(${JSON.stringify(url)}, { method: 'POST', body: form, credentials: 'include' });
            var data = await response.json();
            if (!data || !data.base_resp || data.base_resp.err_msg !== 'ok') {
                return { ok: false, error: (data && data.base_resp && data.base_resp.err_msg) || ('HTTP ' + response.status) };
            }
            if (!data.content) return { ok: false, error: 'upload response had no file id' };
            var fileId = Number(data.content);
            if (!Number.isFinite(fileId)) return { ok: false, error: 'upload response had a non-numeric file id' };
            return { ok: true, fileId: fileId, url: data.cdn_url };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    })()`);
    if (!result?.ok) {
        throw new CommandExecutionError(`WeChat image upload failed for ${image.fileName}: ${result?.error || 'unknown error'}`);
    }
    return { fileId: result.fileId, url: result.url, width: image.width, height: image.height };
}

/**
 * 封面裁剪：把已上传的封面图按 16:9 / 1:1 / 3:4 居中裁剪（服务端裁，
 * crop_multi 一次返回三种比例的图）。返回每种比例的裁剪图 +
 * crop_list0 用的配置。
 */
async function cropCover(page, token, cover) {
    const configs = COVER_RATIOS.map(({ ratio }) => calculateCropConfig(ratio, cover.width, cover.height));
    const sizeFields = configs.map((config, index) =>
        `form.append('size${index}_x1', '${config.x1}');`
        + ` form.append('size${index}_y1', '${config.y1}');`
        + ` form.append('size${index}_x2', '${config.x2}');`
        + ` form.append('size${index}_y2', '${config.y2}');`).join('\n            ');
    const result = await evaluate(page, `(async () => {
        try {
            var form = new FormData();
            form.append('imgurl', ${JSON.stringify(cover.url)});
            form.append('size_count', '${COVER_RATIOS.length}');
            ${sizeFields}
            form.append('token', ${JSON.stringify(token)});
            form.append('lang', 'zh_CN');
            form.append('f', 'json');
            form.append('ajax', '1');
            var response = await fetch('${CROPIMAGE_ENDPOINT}?action=crop_multi', { method: 'POST', body: form, credentials: 'include' });
            return await response.json();
        } catch (error) {
            return { error: String(error && error.message || error) };
        }
    })()`);
    if (result?.error) {
        throw new CommandExecutionError(`WeChat cover crop request failed: ${result.error}`);
    }
    const cropped = parseCropResponse(result);
    if (cropped.length !== COVER_RATIOS.length) {
        throw new CommandExecutionError(`WeChat cover crop returned ${cropped.length} images, expected ${COVER_RATIOS.length}`);
    }
    const crops = cropped.map((item, index) => ({
        ratioLabel: COVER_RATIOS[index].label,
        config: configs[index],
        fileId: item.fileId,
        url: item.url,
    }));
    return { crops, cropList: buildCropList(crops) };
}

async function saveArticleDraft(page, token, formBody) {
    const url = `${OPERATE_APPMSG_ENDPOINT}?t=ajax-response&sub=create&type=77&token=${encodeURIComponent(token)}&lang=zh_CN`;
    const script = `(async () => {
        try {
            var response = await fetch(${JSON.stringify(url)}, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: ${JSON.stringify(formBody)},
                credentials: 'include',
            });
            return await response.json();
        } catch (error) {
            return { error: String(error && error.message || error) };
        }
    })()`;
    const result = await evaluateOnce(page, script);
    if (result?.error) {
        throw new CommandExecutionError(`WeChat draft save request failed: ${result.error}`);
    }
    return parseSaveResponse(result);
}

export const createArticleCommand = cli({
    site: 'weixin',
    name: 'create-article',
    access: 'write',
    description: '创建微信公众号图文草稿（模拟请求路线：正文可带图；仅保存草稿，不发布）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'title', required: true, help: '文章标题 (最长64字)' },
        { name: 'file', positional: true, help: 'Markdown (.md) 或 HTML (.html) 文件路径；Markdown 里 ![](本地图片) 会自动上传换成微信图床地址' },
        { name: 'author', help: '作者（可选）' },
        { name: 'digest', help: '摘要（可选，最长120字；不给则自动生成）' },
        { name: 'cover-image', help: '封面图路径（可选，jpg/png/gif/webp；会按 16:9 / 1:1 / 3:4 裁剪；不给则不设封面）' },
        { name: 'dry-run', type: 'boolean', default: false, help: '只校验标题、文件和图片，不登录、不上传、不建草稿' },
        { name: 'timeout', type: 'int', required: false, default: 300, help: 'Max seconds for the overall command (default: 300)' },
    ],
    columns: ['status', 'detail'],

    func: async (page, kwargs) => {
        try {
            const title = String(kwargs.title ?? '').trim();
            if (!title) throw new ArgumentError('weixin create-article title cannot be empty');
            if (title.length > MAX_TITLE_CHARS) {
                throw new ArgumentError(`weixin create-article title is ${title.length} characters, max ${MAX_TITLE_CHARS}`);
            }
            const fileArg = String(kwargs.file ?? '').trim();
            if (!fileArg) {
                throw new ArgumentError('weixin create-article file cannot be empty (a Markdown or HTML file)');
            }
            const absPath = path.resolve(fileArg);
            let stat;
            try {
                stat = fs.statSync(absPath);
            } catch {
                throw new ArgumentError(`weixin create-article file does not exist: ${absPath}`);
            }
            if (!stat.isFile()) {
                throw new ArgumentError(`weixin create-article file is not a file: ${absPath}`);
            }
            const extension = path.extname(absPath).toLowerCase();
            const isMarkdown = extension === '.md' || extension === '.markdown';
            const isHtml = extension === '.html' || extension === '.htm';
            if (!isMarkdown && !isHtml) {
                throw new ArgumentError(`weixin create-article file must be Markdown (.md) or HTML (.html): ${absPath}`);
            }
            const source = fs.readFileSync(absPath, 'utf8');
            const html = isMarkdown ? markdownToHtml(source) : source;
            const baseDir = path.dirname(absPath);
            const contentImages = resolveContentImages(source, isMarkdown, baseDir);
            const cover = kwargs['cover-image'] ? resolveCoverImage(kwargs['cover-image']) : null;
            const author = String(kwargs.author ?? '').trim();
            const digest = String(kwargs.digest ?? '').trim();

            if (kwargs['dry-run']) {
                return [{
                    status: 'dry-run ok',
                    detail: `"${title}" — ${contentImages.length} content image(s), cover ${cover ? 'yes' : 'no'}, content ${html.length} chars, nothing sent to WeChat`,
                }];
            }

            await page.goto(WEIXIN_HOME);
            await page.wait(2);
            const token = await evaluate(page, `(window.location.href.match(/token=(\\d+)/)||[])[1]`);
            if (!token) {
                throw new AuthRequiredError(WEIXIN_DOMAIN, 'Please log in to the WeChat Official Account platform and retry.');
            }
            const session = await getUploadSession(page, token);

            let finalHtml = html;
            for (const image of contentImages) {
                const uploaded = await uploadImage(page, { ...session, token }, image, 8);
                const key = isMarkdown ? escapeHtml(image.src) : image.src;
                finalHtml = finalHtml.split(`src="${key}"`).join(`src="${uploaded.url}"`);
            }

            let coverData = null;
            if (cover) {
                const uploaded = await uploadImage(page, { ...session, token }, cover, 8);
                coverData = await cropCover(page, token, { ...uploaded, width: cover.width, height: cover.height });
            }

            const formBody = buildArticleForm({
                token,
                title,
                author,
                digest,
                content: finalHtml,
                cover: coverData,
            });
            const appMsgId = await saveArticleDraft(page, token, formBody);
            const editUrl = `${EDIT_PAGE_BASE}?t=media/appmsg_edit&action=edit&type=77&appmsgid=${encodeURIComponent(appMsgId)}&token=${encodeURIComponent(token)}&lang=zh_CN`;
            return [{
                status: 'draft saved',
                detail: `"${title}" (${contentImages.length} content image${contentImages.length === 1 ? '' : 's'}${cover ? ', with cover' : ''}) — draft ${appMsgId}, edit: ${editUrl}`,
            }];
        } catch (error) {
            if (error instanceof CliError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new CommandExecutionError(`WeChat create-article failed: ${message}`);
        }
    },
});
