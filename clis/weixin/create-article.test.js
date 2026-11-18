import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    buildArticleForm,
    buildCropList,
    buildFiletransferUrl,
    calculateCropConfig,
    collectImageSources,
    escapeHtml,
    markdownToHtml,
    parseCropResponse,
    parseSaveResponse,
    readImageDimensions,
    resolveContentImages,
} from './create-article.js';
import './create-article.js';

// --- minimal image fixtures (headers only; the adapter reads dimensions) ---

function makePng(width, height) {
    const buffer = Buffer.alloc(8 + 4 + 4 + 13 + 4 + 12);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer[24] = 8;
    buffer[25] = 2;
    buffer.write('IEND', 33, 'ascii');
    return buffer;
}

function makeJpeg(width, height) {
    const buffer = Buffer.alloc(2 + 2 + 2 + 14 + 2 + 2 + 1 + 2 + 2 + 1 + 9);
    let offset = 0;
    buffer[offset++] = 0xff; buffer[offset++] = 0xd8;
    buffer[offset++] = 0xff; buffer[offset++] = 0xe0;
    buffer.writeUInt16BE(16, offset); offset += 2;
    buffer.write('JFIF\0', offset, 'ascii'); offset += 5;
    buffer[offset++] = 1; buffer[offset++] = 1; buffer[offset++] = 0;
    buffer.writeUInt16BE(1, offset); offset += 2;
    buffer.writeUInt16BE(1, offset); offset += 2;
    buffer[offset++] = 0; buffer[offset++] = 0;
    buffer[offset++] = 0xff; buffer[offset++] = 0xc0;
    buffer.writeUInt16BE(17, offset); offset += 2;
    buffer[offset++] = 8;
    buffer.writeUInt16BE(height, offset); offset += 2;
    buffer.writeUInt16BE(width, offset); offset += 2;
    buffer[offset++] = 3;
    buffer[offset++] = 1; buffer[offset++] = 0x11; buffer[offset++] = 0;
    buffer[offset++] = 2; buffer[offset++] = 0x11; buffer[offset++] = 1;
    buffer[offset++] = 3; buffer[offset++] = 0x11; buffer[offset++] = 1;
    return buffer;
}

function envelope(data) {
    return { session: 'site:weixin:test', data };
}

const HTML_SESSION = '<html><script>window.wx.commonData = {t: "123456", ticket: "TICKET123", user_name: "gh_abcdef", nick_name: "test"};</script></html>';
const MESSAGE_LIST = { user_info: { user_name: 'gh_abcdef' }, base_resp: { media_ticket: 'TICKET123' } };

const CROP_OK = {
    base_resp: { err_msg: 'ok' },
    result: [
        { cdnurl: 'https://mmbiz.qpic.cn/crop169', file_id: 200001, height: 663, width: 1178 },
        { cdnurl: 'https://mmbiz.qpic.cn/crop11', file_id: 200002, height: 1178, width: 1178 },
        { cdnurl: 'https://mmbiz.qpic.cn/crop34', file_id: 200003, height: 1570, width: 1178 },
    ],
};

function createPageMock(overrides = {}) {
    let uploadCount = 0;
    const seen = { scripts: [] };
    const evaluate = overrides.evaluate ?? vi.fn().mockImplementation(async (script) => {
        seen.scripts.push(script);
        if (script.includes('window.location.href.match')) return envelope(Object.hasOwn(overrides, 'token') ? overrides.token : '123456');
        if (script.includes('cgi-bin/cropimage')) {
            if (overrides.cropFails) return envelope({ base_resp: { ret: 40001, err_msg: 'crop failed' } });
            return envelope(CROP_OK);
        }
        if (script.includes('cgi-bin/filetransfer')) {
            uploadCount += 1;
            if (overrides.uploadFails) return envelope({ ok: false, error: 'boom' });
            return envelope({ ok: true, fileId: 100000 + uploadCount, url: `https://mmbiz.qpic.cn/img${uploadCount}` });
        }
        if (script.includes('cgi-bin/message')) return envelope(overrides.messageList ?? MESSAGE_LIST);
        if (script.includes("fetch('https://mp.weixin.qq.com/'")) return envelope(overrides.html ?? HTML_SESSION);
        return envelope(undefined);
    });
    const evaluateOnce = overrides.evaluateOnce ?? vi.fn().mockImplementation(async (script) => {
        seen.scripts.push(script);
        if (script.includes('operate_appmsg')) {
            if (overrides.saveResponse) return envelope(overrides.saveResponse);
            return envelope({ appMsgId: '100000001' });
        }
        return envelope(undefined);
    });
    return {
        page: {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate,
            evaluateOnce,
            setFileInput: vi.fn().mockResolvedValue(undefined),
        },
        seen,
    };
}

const tempDirs = [];

function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-weixin-article-'));
    tempDirs.push(dir);
    return dir;
}

function writeTempFile(dir, name, content) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
}

afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function getCommand() {
    return getRegistry().get('weixin/create-article');
}

describe('weixin create-article pure helpers', () => {
    it('escapes HTML in text', () => {
        expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
    });

    it('converts headings, paragraphs, and line breaks', () => {
        const html = markdownToHtml('# 标题\n\n第一行\n第二行\n\n## 小标题\n\n正文。');
        expect(html).toContain('<h1>标题</h1>');
        expect(html).toContain('<p>第一行<br>第二行</p>');
        expect(html).toContain('<h2>小标题</h2>');
        expect(html).toContain('<p>正文。</p>');
    });

    it('converts inline images, links, bold, italic, and code', () => {
        const html = markdownToHtml('看这张 ![图](./a.png) 和[链接](https://example.com)，**粗体**、*斜体*、`代码`。');
        expect(html).toContain('<img src="./a.png" alt="图">');
        expect(html).toContain('<a href="https://example.com">链接</a>');
        expect(html).toContain('<strong>粗体</strong>');
        expect(html).toContain('<em>斜体</em>');
        expect(html).toContain('<code>代码</code>');
    });

    it('converts lists, blockquotes, hr, and code fences', () => {
        const html = markdownToHtml('- 一\n- 二\n\n1. 先\n2. 后\n\n> 引用\n\n---\n\n```\nconst a = 1 < 2;\n```');
        expect(html).toContain('<ul><li>一</li><li>二</li></ul>');
        expect(html).toContain('<ol><li>先</li><li>后</li></ol>');
        expect(html).toContain('<blockquote><p>引用</p></blockquote>');
        expect(html).toContain('<hr>');
        expect(html).toContain('<pre><code>const a = 1 &lt; 2;</code></pre>');
    });

    it('reads PNG and JPEG dimensions', () => {
        expect(readImageDimensions(makePng(1080, 1440), '.png')).toEqual({ width: 1080, height: 1440 });
        expect(readImageDimensions(makeJpeg(800, 600), '.jpg')).toEqual({ width: 800, height: 600 });
        expect(readImageDimensions(Buffer.from('hello world, not an image'), '.png')).toBeNull();
    });

    it('collects image sources from Markdown and HTML, deduped', () => {
        expect(collectImageSources('![a](./x.png) text ![b](./x.png) ![c](https://e.com/y.jpg)', true))
            .toEqual(['./x.png', 'https://e.com/y.jpg']);
        expect(collectImageSources('<p><img src="./x.png"><img src="./x.png"></p>', false))
            .toEqual(['./x.png']);
    });

    it('resolves local content images and skips remote ones', () => {
        const dir = createTempDir();
        writeTempFile(dir, 'a.png', makePng(1080, 1440));
        const images = resolveContentImages('![a](./a.png)\n\n![b](https://example.com/b.jpg)', true, dir);
        expect(images).toHaveLength(1);
        expect(images[0].src).toBe('./a.png');
        expect(images[0].width).toBe(1080);
        expect(images[0].height).toBe(1440);
        expect(images[0].base64.length).toBeGreaterThan(0);
    });

    it('rejects a missing content image', () => {
        const dir = createTempDir();
        expect(() => resolveContentImages('![a](./nope.png)', true, dir)).toThrow(/does not exist/);
    });

    it('calculates centered crops matching the MultiPost template numbers', () => {
        // 1178x1570 is the 3:4 source behind MultiPost's hardcoded crop_list.
        // Math.round 按 MultiPost 的 calculateCropConfig 原样算：
        // 16:9 在 1178x1570 上 y1_abs=454、y2_abs=1116（它表单里写死的
        // 453/1116 是另一张原图的快照值，不是本尺寸的公式输出）。
        const wide = calculateCropConfig(16 / 9, 1178, 1570);
        expect(wide.y1).toBeCloseTo(0.289, 3);
        expect(wide.y2).toBeCloseTo(0.711, 3);
        expect(wide.y1_abs).toBe(454);
        expect(wide.y2_abs).toBe(1116);
        const square = calculateCropConfig(1, 1178, 1570);
        expect(square.y1).toBeCloseTo(0.1248, 3);
        expect(square.y1_abs).toBe(196);
        expect(square.y2_abs).toBe(1374);
        // 1178/1570 = 0.7503…，比 3/4 大一点点，所以按“太宽”切两边，
        // 切掉的只是 0.25 像素——这正是 MultiPost 模板里那个
        // 2.1222410865878727e-20 的怪数字的来源，公式原样复现了它。
        const tall = calculateCropConfig(3 / 4, 1178, 1570);
        expect(tall.x1).toBeCloseTo(0.0002122, 6);
        expect(tall.x2).toBeCloseTo(0.9997878, 6);
        expect(tall.y1).toBe(0);
        expect(tall.y2).toBe(1);
        expect(tall.x1_abs).toBe(0);
        expect(tall.x2_abs).toBe(1178);
    });

    it('builds crop_list0 with absolute and percent coords per ratio', () => {
        const crops = [
            { ratioLabel: '16_9', config: calculateCropConfig(16 / 9, 1178, 1570), fileId: 200001 },
            { ratioLabel: '1_1', config: calculateCropConfig(1, 1178, 1570), fileId: 200002 },
            { ratioLabel: '3_4', config: calculateCropConfig(3 / 4, 1178, 1570), fileId: 200003 },
        ];
        const parsed = JSON.parse(buildCropList(crops));
        expect(parsed.crop_list).toHaveLength(3);
        expect(parsed.crop_list[0]).toEqual({ ratio: '16_9', x1: 0, y1: 454, x2: 1178, y2: 1116, file_id: 200001 });
        expect(parsed.crop_list_percent[1].ratio).toBe('1_1');
        expect(parsed.crop_list_percent[1].file_id).toBe(200002);
        expect(parsed.crop_list_percent[2].y2).toBe(1);
    });

    it('builds the filetransfer URL with scene=8 by default', () => {
        const url = buildFiletransferUrl({ token: '123456', ticket: 'TICKET123', userName: 'gh_abcdef' });
        expect(url).toContain('cgi-bin/filetransfer');
        expect(url).toContain('scene=8');
        expect(url).toContain('ticket=TICKET123');
    });

    it('builds the article form without a cover and without the newspic switches', () => {
        const body = buildArticleForm({
            token: '123456', title: '标题', author: '', digest: '', content: '<p>正文</p>', cover: null,
        });
        const params = new URLSearchParams(body);
        expect(params.get('title0')).toBe('标题');
        expect(params.get('content0')).toBe('<p>正文</p>');
        expect(params.get('auto_gen_digest0')).toBe('1');
        expect(params.get('cdn_url0')).toBe('');
        expect(params.get('crop_list0')).toBe('');
        expect(params.get('share_page_type0')).toBe('0');
        expect(params.get('share_imageinfo0')).toBe('{"list":[]}');
        expect(params.get('style_type0')).toBeNull();
        expect(params.get('save_type')).toBeNull();
        expect(params.get('fileid0')).toBe('');
    });

    it('builds the article form with digest and cover fields', () => {
        const cover = {
            crops: [
                { ratioLabel: '16_9', config: calculateCropConfig(16 / 9, 1178, 1570), fileId: 200001, url: 'https://mmbiz.qpic.cn/crop169' },
                { ratioLabel: '1_1', config: calculateCropConfig(1, 1178, 1570), fileId: 200002, url: 'https://mmbiz.qpic.cn/crop11' },
                { ratioLabel: '3_4', config: calculateCropConfig(3 / 4, 1178, 1570), fileId: 200003, url: 'https://mmbiz.qpic.cn/crop34' },
            ],
            cropList: buildCropList([
                { ratioLabel: '16_9', config: calculateCropConfig(16 / 9, 1178, 1570), fileId: 200001 },
                { ratioLabel: '1_1', config: calculateCropConfig(1, 1178, 1570), fileId: 200002 },
                { ratioLabel: '3_4', config: calculateCropConfig(3 / 4, 1178, 1570), fileId: 200003 },
            ]),
        };
        const body = buildArticleForm({
            token: '123456', title: '标题', author: '作者', digest: '摘要'.repeat(100), content: '<p>正文</p>', cover,
        });
        const params = new URLSearchParams(body);
        expect(params.get('author0')).toBe('作者');
        expect(params.get('digest0').length).toBe(120);
        expect(params.get('auto_gen_digest0')).toBe('0');
        expect(params.get('cdn_url0')).toBe('https://mmbiz.qpic.cn/crop11');
        expect(params.get('cdn_235_1_url0')).toBe('https://mmbiz.qpic.cn/crop11');
        expect(params.get('cdn_16_9_url0')).toBe('https://mmbiz.qpic.cn/crop169');
        expect(params.get('cdn_3_4_url0')).toBe('https://mmbiz.qpic.cn/crop34');
        expect(params.get('cdn_1_1_url0')).toBe('https://mmbiz.qpic.cn/crop11');
        const cropList = JSON.parse(params.get('crop_list0'));
        expect(cropList.crop_list).toHaveLength(3);
        expect(cropList.crop_list[2].file_id).toBe(200003);
    });

    it('parses crop_multi responses', () => {
        const cropped = parseCropResponse(CROP_OK);
        expect(cropped).toHaveLength(3);
        expect(cropped[0]).toEqual({ url: 'https://mmbiz.qpic.cn/crop169', fileId: 200001, width: 1178, height: 663 });
        expect(() => parseCropResponse({ base_resp: { ret: 40001, err_msg: 'crop failed' } }))
            .toThrow(/crop failed/);
    });

    it('parses save responses and explains the 200040 duplicate error', () => {
        expect(parseSaveResponse({ appMsgId: '100000001' })).toBe('100000001');
        expect(() => parseSaveResponse({ base_resp: { ret: 200040, err_msg: 'save limited' } }))
            .toThrow(/200040/);
        expect(() => parseSaveResponse({ base_resp: { ret: 40007, err_msg: 'invalid media_id' } }))
            .toThrow(/40007/);
        expect(() => parseSaveResponse({})).toThrow(/did not return a draft id/);
    });
});

describe('weixin create-article command', () => {
    it('saves a draft with a content image and a cover', async () => {
        const { page, seen } = createPageMock();
        const dir = createTempDir();
        writeTempFile(dir, 'a.png', makePng(1080, 1440));
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文第一段。\n\n![插图](./a.png)\n');
        const coverPath = writeTempFile(dir, 'cover.jpg', makeJpeg(1178, 1570));
        const result = await getCommand().func(page, {
            title: '文章标题',
            file: mdPath,
            'cover-image': coverPath,
        });
        expect(result).toEqual([{
            status: 'draft saved',
            detail: expect.stringContaining('"文章标题" (1 content image, with cover) — draft 100000001, edit: https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=100000001&token=123456&lang=zh_CN'),
        }]);
        const joined = seen.scripts.join('\n');
        expect(joined).toContain('scene=8');
        expect(joined).toContain('cgi-bin/cropimage');
        expect(joined).toContain('crop_multi');
        expect(joined).toContain('operate_appmsg');
        expect(joined).toContain('mmbiz.qpic.cn%2Fimg'); // uploaded content image URL inside content0
        expect(joined).not.toContain('style_type0');
    });

    it('saves a draft without a cover and without calling crop_multi', async () => {
        const { page, seen } = createPageMock();
        const dir = createTempDir();
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n纯文字正文。\n');
        const result = await getCommand().func(page, { title: '纯文字', file: mdPath });
        expect(result[0].status).toBe('draft saved');
        expect(seen.scripts.join('\n')).not.toContain('crop_multi');
    });

    it('accepts a raw HTML file without Markdown conversion', async () => {
        const { page, seen } = createPageMock();
        const dir = createTempDir();
        const htmlPath = writeTempFile(dir, 'post.html', '<section class="lead"><p>正文</p></section>');
        const result = await getCommand().func(page, { title: 'HTML', file: htmlPath });
        expect(result[0].status).toBe('draft saved');
        expect(seen.scripts.join('\n')).toContain('%3Csection');
    });

    it('dry-run validates without touching the browser', async () => {
        const { page } = createPageMock();
        const dir = createTempDir();
        writeTempFile(dir, 'a.png', makePng(1080, 1440));
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n![图](./a.png)\n');
        const coverPath = writeTempFile(dir, 'cover.jpg', makeJpeg(1178, 1570));
        const result = await getCommand().func(page, {
            title: '标题', file: mdPath, 'cover-image': coverPath, 'dry-run': true,
        });
        expect(result[0].status).toBe('dry-run ok');
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('throws AuthRequiredError when no session token is available', async () => {
        const { page } = createPageMock({ token: undefined });
        const dir = createTempDir();
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文。\n');
        await expect(getCommand().func(page, { title: '标题', file: mdPath }))
            .rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('falls back to the message list when the homepage has no ticket', async () => {
        const { page } = createPageMock({ html: '<html></html>' });
        const dir = createTempDir();
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文。\n');
        const result = await getCommand().func(page, { title: '标题', file: mdPath });
        expect(result[0].status).toBe('draft saved');
    });

    it('fails clearly when an image upload fails', async () => {
        const { page } = createPageMock({ uploadFails: true });
        const dir = createTempDir();
        writeTempFile(dir, 'a.png', makePng(1080, 1440));
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n![图](./a.png)\n');
        await expect(getCommand().func(page, { title: '标题', file: mdPath }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('fails clearly when the cover crop fails', async () => {
        const { page } = createPageMock({ cropFails: true });
        const dir = createTempDir();
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文。\n');
        const coverPath = writeTempFile(dir, 'cover.jpg', makeJpeg(1178, 1570));
        await expect(getCommand().func(page, { title: '标题', file: mdPath, 'cover-image': coverPath }))
            .rejects.toThrow(/crop failed/);
    });

    it('surfaces the 200040 duplicate-content error from the save step', async () => {
        const { page } = createPageMock({ saveResponse: { base_resp: { ret: 200040, err_msg: 'save limited' } } });
        const dir = createTempDir();
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文。\n');
        await expect(getCommand().func(page, { title: '标题', file: mdPath }))
            .rejects.toThrow(/200040/);
    });

    it('rejects a missing file, a wrong extension, or a title over 64 chars', async () => {
        const { page } = createPageMock();
        const dir = createTempDir();
        await expect(getCommand().func(page, { title: '标题', file: '/tmp/does-not-exist-12345.md' }))
            .rejects.toBeInstanceOf(ArgumentError);
        const txtPath = writeTempFile(dir, 'post.txt', 'hello');
        await expect(getCommand().func(page, { title: '标题', file: txtPath }))
            .rejects.toBeInstanceOf(ArgumentError);
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n正文。\n');
        await expect(getCommand().func(page, { title: '标'.repeat(65), file: mdPath }))
            .rejects.toBeInstanceOf(ArgumentError);
    });

    it('rejects an oversized content image', async () => {
        const { page } = createPageMock();
        const dir = createTempDir();
        writeTempFile(dir, 'big.png', Buffer.concat([makePng(1080, 1440), Buffer.alloc(6 * 1024 * 1024)]));
        const mdPath = writeTempFile(dir, 'post.md', '# 标题\n\n![图](./big.png)\n');
        await expect(getCommand().func(page, { title: '标题', file: mdPath }))
            .rejects.toThrow(/6 MB/);
    });
});
