/**
 * weixin create-newspic — 创建微信公众号小绿书（图片消息）草稿。
 *
 * 小绿书 = 图片消息 (article_type=newspic)：1–20 张图片（首张即封面）+ 标题
 * + 一段纯文本描述。OpenCLI 上游的 weixin create-draft 只能建普通图文，
 * 本文件补上图片消息这一形态。
 *
 * 路线：网页接口（复用浏览器登录会话，不用 AppID/AppSecret，不用 IP 白名单，
 * 个人号可用）。两步走，与图文共用保存接口：
 *   1. 每张图 POST https://mp.weixin.qq.com/cgi-bin/filetransfer
 *      ?action=upload_material&scene=5 …（scene=5 是动态/小绿书场景，文章用 8）
 *      → 拿 file_id（数字）+ cdn_url。
 *   2. POST https://mp.weixin.qq.com/cgi-bin/operate_appmsg
 *      ?t=ajax-response&sub=create&type=77 …，表单带 share_imageinfo0
 *      （图片列表）和 style_type0=3 / new_pic_process0=1 /
 *      is_auto_type_setting=3 / save_type=1 / isneedsave=0 这组开关，
 *      决定存成「图片消息」而非普通文章。
 *   只建草稿，不发布。发布永远由人在公众号后台点。
 *
 * 协议来源：dsh-wechat-mp-studio 的 xiaolvshu-web-api.md（2026 实测）与
 * MultiPost 的 weixin.ts（同一表单，两处实现互相印证）。网页接口是微信
 * 内部接口、无公开文档，参数随时可能变；若某天失效，先按文档里的办法
 * 重新核对表单再改本文件。
 *
 * 安装（可迁移到任何装了 OpenCLI 的机器）：
 *   把本文件复制到 ~/.opencli/clis/weixin/create-newspic.js 即可，
 *   OpenCLI 启动时会扫描该目录自动发现（见同目录 install.mjs）。
 * 用法：
 *   opencli weixin create-newspic --title "标题" --images a.jpg,b.jpg "描述文字"
 *   opencli weixin create-newspic --title "标题" --images ./cards/*.jpg --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';

const WEIXIN_DOMAIN = 'mp.weixin.qq.com';
const WEIXIN_HOME = 'https://mp.weixin.qq.com/';
const FILETRANSFER_ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/filetransfer';
const OPERATE_APPMSG_ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/operate_appmsg';
const EDIT_PAGE_BASE = 'https://mp.weixin.qq.com/cgi-bin/appmsg';

const MAX_IMAGES = 20;
const MAX_TITLE_CHARS = 64;
const MAX_CONTENT_CHARS = 1000;
/** 单张图上限：evaluate 里传 base64 有体积限制，超过就让用户先压缩。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** 小绿书图片的默认主题色（与实测实现一致的常量）。 */
const THEME_COLOR = 'rgb(187,166,135)';

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
// 纯函数：校验、图片尺寸、表单构造 —— 不依赖浏览器，可直接单测。
// ---------------------------------------------------------------------------

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

/** 解析 --images：逗号分隔的本地路径，1–20 张。返回含 base64 与宽高的图片列表。 */
export function resolveImages(raw) {
    const values = String(raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) {
        throw new ArgumentError('weixin create-newspic images cannot be empty (comma-separated local paths, 1-20 images)');
    }
    if (values.length > MAX_IMAGES) {
        throw new ArgumentError(`weixin create-newspic accepts at most ${MAX_IMAGES} images, got ${values.length}`);
    }
    return values.map((value, index) => {
        const label = `image #${index + 1}`;
        const absPath = path.resolve(value);
        let stat;
        try {
            stat = fs.statSync(absPath);
        } catch {
            throw new ArgumentError(`weixin create-newspic ${label} does not exist: ${absPath}`);
        }
        if (!stat.isFile()) {
            throw new ArgumentError(`weixin create-newspic ${label} is not a file: ${absPath}`);
        }
        const extension = path.extname(absPath).toLowerCase();
        const mimeType = IMAGE_MIME_TYPES.get(extension);
        if (!mimeType) {
            throw new ArgumentError(`weixin create-newspic ${label} must be JPEG, PNG, GIF, or WebP: ${absPath}`);
        }
        if (stat.size > MAX_IMAGE_BYTES) {
            throw new ArgumentError(
                `weixin create-newspic ${label} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 6 MB limit; compress it first (under 2 MB is safest for review): ${absPath}`,
            );
        }
        const buffer = fs.readFileSync(absPath);
        const dimensions = readImageDimensions(buffer, extension);
        if (!dimensions || !dimensions.width || !dimensions.height) {
            throw new ArgumentError(`weixin create-newspic ${label} looks like an image but its size could not be read: ${absPath}`);
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

/** filetransfer 上传地址：scene=5 是小绿书/动态场景（文章用 8，传错拿不到 file_id）。 */
export function buildFiletransferUrl({ token, ticket, userName }) {
    const url = new URL(FILETRANSFER_ENDPOINT);
    url.searchParams.set('action', 'upload_material');
    url.searchParams.set('f', 'json');
    url.searchParams.set('scene', '5');
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

/** operate_appmsg 的 share_imageinfo0：file_id 必须是数字，首张即封面。 */
export function buildShareImageInfo(images) {
    return {
        list: images.map((image) => ({
            url: image.url,
            file_id: image.fileId,
            width: image.width,
            height: image.height,
            theme_color: THEME_COLOR,
            disable_theme: 0,
            disable_live: 0,
            cdn_url: image.url,
        })),
    };
}

/**
 * operate_appmsg 的完整表单。style_type0=3 + new_pic_process0=1 +
 * is_auto_type_setting=3 + save_type=1 + isneedsave=0 这组开关决定存成
 * 「图片消息」而非普通文章，缺一个都可能存错形态。
 */
export function buildNewspicForm({ token, title, content, images }) {
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
    set('autosave_log', 'true');
    set('articlenum', '1');
    set('pre_timesend_set', '0');
    set('is_finder_video0', '0');
    set('finder_draft_id0', '0');
    set('applyori0', '0');
    set('ad_video_transition0', '');
    set('can_reward0', '0');
    set('related_video0', '');
    set('is_video_recommend0', '-1');
    set('title0', title);
    set('is_user_title0', '1');
    set('author0', '');
    set('writerid0', '0');
    set('fileid0', '');
    set('digest0', '');
    set('auto_gen_digest0', '1');
    set('content0', content);
    set('sourceurl0', '');
    set('need_open_comment0', '1');
    set('only_fans_can_comment0', '0');
    set('only_fans_days_can_comment0', '0');
    set('reply_flag0', '2');
    set('not_pay_can_comment0', '0');
    set('auto_elect_comment0', '0');
    set('auto_elect_reply0', '0');
    set('open_fansmsg0', '0');
    set('share_imageinfo0', JSON.stringify(buildShareImageInfo(images)));
    set('share_page_type0', images.length > 0 ? '8' : '0');
    set('music_id0', '');
    set('video_id0', '');
    set('voteid0', '');
    set('voteismlt0', '');
    set('supervoteid0', '');
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
    set('guide_words0', content);
    set('is_share_copyright0', '0');
    set('share_copyright_url0', '');
    set('source_article_type0', '');
    set('reprint_recommend_title0', '');
    set('reprint_recommend_content0', '');
    set('share_video_id0', '');
    set('dot0', '{}');
    set('share_voice_id0', '');
    set('insert_ad_mode0', '');
    set('categories_list0', '[]');
    set('compose_info0', '{"list":""}');
    set('is_pay_subscribe0', '0');
    set('pay_fee0', '');
    set('pay_preview_percent0', '');
    set('pay_desc0', '');
    set('pay_album_info0', '');
    set('appmsg_album_info0', '{"appmsg_album_infos":[]}');
    set('open_keyword_ad0', '1');
    set('audio_info0', '');
    set('danmu_pub_type0_0', '0');
    set('mp_video_info0', '{"list":[]}');
    set('is_set_sync_to_finder0', '0');
    set('sync_to_finder_cover0', '');
    set('sync_to_finder_cover_source0', '');
    set('import_to_finder0', '0');
    set('import_from_finder_export_id0', '');
    set('style_type0', '3');
    set('sticker_info0', '{}');
    set('new_pic_process0', '1');
    set('disable_recommend0', '0');
    set('claim_source_type0', '');
    set('msg_index_id0', '');
    set('convert_to_image_share_page0', '');
    set('convert_from_image_share_page0', '');
    set('multi_picture_cover0', '0');
    set('is_auto_type_setting', '3');
    set('save_type', '1');
    set('isneedsave', '0');
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
            'WeChat rejected the draft as a duplicate (200040 保存受限): it keys on title + description only, not the images. '
            + 'Reword the title or description and retry; waiting does not help.',
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

async function uploadImage(page, session, image) {
    const url = buildFiletransferUrl(session);
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

async function saveNewspicDraft(page, token, formBody) {
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

export const createNewspicCommand = cli({
    site: 'weixin',
    name: 'create-newspic',
    access: 'write',
    description: '创建微信公众号小绿书（图片消息）草稿（仅保存草稿，不发布）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'title', required: true, help: '小绿书标题 (最长64字)' },
        { name: 'content', positional: true, help: '描述文字 (最长1000字，可空)' },
        { name: 'images', required: true, help: '图片路径，逗号分隔，1-20 张 (jpg/png/gif/webp)，首张即封面；单张不超 6 MB，2 MB 以内最稳' },
        { name: 'tags', help: '话题标签，逗号分隔，会以 #标签 形式追加到描述末尾' },
        { name: 'dry-run', type: 'boolean', default: false, help: '只校验标题、描述和图片，不登录、不上传、不建草稿' },
        { name: 'timeout', type: 'int', required: false, default: 300, help: 'Max seconds for the overall command (default: 300)' },
    ],
    columns: ['status', 'detail'],

    func: async (page, kwargs) => {
        try {
            const title = String(kwargs.title ?? '').trim();
            if (!title) throw new ArgumentError('weixin create-newspic title cannot be empty');
            if (title.length > MAX_TITLE_CHARS) {
                throw new ArgumentError(`weixin create-newspic title is ${title.length} characters, max ${MAX_TITLE_CHARS}`);
            }
            const images = resolveImages(kwargs.images);
            let content = String(kwargs.content ?? '');
            const tags = String(kwargs.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
            if (tags.length) content = `${content}${content ? ' ' : ''}${tags.map((tag) => `#${tag}`).join(' ')}`;
            if (content.length > MAX_CONTENT_CHARS) {
                throw new ArgumentError(`weixin create-newspic description is ${content.length} characters, max ${MAX_CONTENT_CHARS}`);
            }

            if (kwargs['dry-run']) {
                return [{
                    status: 'dry-run ok',
                    detail: `"${title}" — ${images.length} image(s) validated, description ${content.length} chars, nothing sent to WeChat`,
                }];
            }

            await page.goto(WEIXIN_HOME);
            await page.wait(2);
            const token = await evaluate(page, `(window.location.href.match(/token=(\\d+)/)||[])[1]`);
            if (!token) {
                throw new AuthRequiredError(WEIXIN_DOMAIN, 'Please log in to the WeChat Official Account platform and retry.');
            }
            const session = await getUploadSession(page, token);
            const uploaded = [];
            for (const image of images) {
                uploaded.push(await uploadImage(page, { ...session, token }, image));
            }
            const formBody = buildNewspicForm({ token, title, content, images: uploaded });
            const appMsgId = await saveNewspicDraft(page, token, formBody);
            const editUrl = `${EDIT_PAGE_BASE}?t=media/appmsg_edit&action=edit&type=77&appmsgid=${encodeURIComponent(appMsgId)}&token=${encodeURIComponent(token)}&lang=zh_CN`;
            return [{
                status: 'draft saved',
                detail: `"${title}" (${uploaded.length} image${uploaded.length > 1 ? 's' : ''}) — draft ${appMsgId}, edit: ${editUrl}`,
            }];
        } catch (error) {
            if (error instanceof CliError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            throw new CommandExecutionError(`WeChat create-newspic failed: ${message}`);
        }
    },
});
