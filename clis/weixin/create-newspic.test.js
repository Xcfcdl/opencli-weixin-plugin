import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
    buildFiletransferUrl,
    buildNewspicForm,
    parseSaveResponse,
    parseSessionFromHtml,
    parseSessionFromMessageList,
    readImageDimensions,
} from './create-newspic.js';
import './create-newspic.js';

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

function makeGif(width, height) {
    const buffer = Buffer.alloc(13);
    buffer.write('GIF89a', 0, 'ascii');
    buffer.writeUInt16LE(width, 6);
    buffer.writeUInt16LE(height, 8);
    return buffer;
}

function makeWebpLossless(width, height) {
    const buffer = Buffer.alloc(25);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(17, 4);
    buffer.write('WEBP', 8, 'ascii');
    buffer.write('VP8L', 12, 'ascii');
    buffer.writeUInt32LE(5, 16);
    buffer[20] = 0x2f;
    buffer.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
    return buffer;
}

function makeWebpExtended(width, height) {
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(22, 4);
    buffer.write('WEBP', 8, 'ascii');
    buffer.write('VP8X', 12, 'ascii');
    buffer.writeUInt32LE(10, 16);
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
    return buffer;
}

function envelope(data) {
    return { session: 'site:weixin:test', data };
}

const HTML_SESSION = '<html><script>window.wx.commonData = {t: "123456", ticket: "TICKET123", user_name: "gh_abcdef", nick_name: "test"};</script></html>';
const MESSAGE_LIST = { user_info: { user_name: 'gh_abcdef' }, base_resp: { media_ticket: 'TICKET123' } };

function createPageMock(overrides = {}) {
    let uploadCount = 0;
    const seen = { scripts: [] };
    const evaluate = overrides.evaluate ?? vi.fn().mockImplementation(async (script) => {
        seen.scripts.push(script);
        if (script.includes('window.location.href.match')) return envelope(Object.hasOwn(overrides, 'token') ? overrides.token : '123456');
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

function createTempImage(name, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-weixin-newspic-'));
    tempDirs.push(dir);
    const imagePath = path.join(dir, name);
    fs.writeFileSync(imagePath, buffer);
    return imagePath;
}

afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function getCommand() {
    return getRegistry().get('weixin/create-newspic');
}

describe('weixin create-newspic pure helpers', () => {
    it('reads PNG dimensions', () => {
        expect(readImageDimensions(makePng(1080, 1440), '.png')).toEqual({ width: 1080, height: 1440 });
    });

    it('reads JPEG dimensions', () => {
        expect(readImageDimensions(makeJpeg(800, 600), '.jpg')).toEqual({ width: 800, height: 600 });
    });

    it('reads GIF dimensions', () => {
        expect(readImageDimensions(makeGif(320, 240), '.gif')).toEqual({ width: 320, height: 240 });
    });

    it('reads WebP lossless and extended dimensions', () => {
        expect(readImageDimensions(makeWebpLossless(1080, 1440), '.webp')).toEqual({ width: 1080, height: 1440 });
        expect(readImageDimensions(makeWebpExtended(640, 480), '.webp')).toEqual({ width: 640, height: 480 });
    });

    it('returns null for non-image bytes', () => {
        expect(readImageDimensions(Buffer.from('hello world, not an image'), '.png')).toBeNull();
    });

    it('parses ticket and user_name from homepage HTML', () => {
        expect(parseSessionFromHtml(HTML_SESSION)).toEqual({ ticket: 'TICKET123', userName: 'gh_abcdef' });
        expect(parseSessionFromHtml('<html></html>')).toEqual({ ticket: '', userName: '' });
    });

    it('parses ticket and user_name from message-list JSON', () => {
        expect(parseSessionFromMessageList(MESSAGE_LIST)).toEqual({ ticket: 'TICKET123', userName: 'gh_abcdef' });
        expect(parseSessionFromMessageList(null)).toEqual({ ticket: '', userName: '' });
    });

    it('builds the filetransfer URL with scene=5', () => {
        const url = buildFiletransferUrl({ token: '123456', ticket: 'TICKET123', userName: 'gh_abcdef' });
        expect(url).toContain('cgi-bin/filetransfer');
        expect(url).toContain('scene=5');
        expect(url).toContain('ticket=TICKET123');
        expect(url).toContain('ticket_id=gh_abcdef');
        expect(url).toContain('token=123456');
    });

    it('builds the newspic form with the five image-message switches', () => {
        const body = buildNewspicForm({
            token: '123456',
            title: '标题',
            content: '描述',
            images: [{ fileId: 100001, url: 'https://mmbiz.qpic.cn/a', width: 1080, height: 1440 }],
        });
        const params = new URLSearchParams(body);
        expect(params.get('title0')).toBe('标题');
        expect(params.get('content0')).toBe('描述');
        expect(params.get('guide_words0')).toBe('描述');
        expect(params.get('style_type0')).toBe('3');
        expect(params.get('new_pic_process0')).toBe('1');
        expect(params.get('is_auto_type_setting')).toBe('3');
        expect(params.get('save_type')).toBe('1');
        expect(params.get('isneedsave')).toBe('0');
        expect(params.get('share_page_type0')).toBe('8');
        const info = JSON.parse(params.get('share_imageinfo0'));
        expect(info.list).toHaveLength(1);
        expect(info.list[0].file_id).toBe(100001);
        expect(typeof info.list[0].file_id).toBe('number');
        expect(info.list[0].url).toBe('https://mmbiz.qpic.cn/a');
        expect(info.list[0].width).toBe(1080);
        expect(info.list[0].height).toBe(1440);
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

describe('weixin create-newspic command', () => {
    it('saves a draft and returns the edit URL', async () => {
        const { page, seen } = createPageMock();
        const first = createTempImage('a.png', makePng(1080, 1440));
        const second = createTempImage('b.jpg', makeJpeg(800, 600));
        const result = await getCommand().func(page, {
            title: '小绿书标题',
            content: '描述文字',
            images: `${first},${second}`,
        });
        expect(result).toEqual([{
            status: 'draft saved',
            detail: expect.stringContaining('"小绿书标题" (2 images) — draft 100000001, edit: https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=100000001&token=123456&lang=zh_CN'),
        }]);
        const joined = seen.scripts.join('\n');
        expect(joined).toContain('scene=5');
        expect(joined).toContain('style_type0');
        expect(joined).toContain('save_type');
    });

    it('appends tags to the description', async () => {
        const { page, seen } = createPageMock();
        const first = createTempImage('a.png', makePng(1080, 1440));
        await getCommand().func(page, { title: '标题', content: '描述', images: first, tags: 'AI,无露脸' });
        const joined = seen.scripts.join('\n');
        expect(joined).toContain('%23AI'); // URL-encoded #AI inside content0
        expect(joined).toContain('%23%E6%97%A0%E9%9C%B2%E8%84%B8');
    });

    it('dry-run validates without touching the browser', async () => {
        const { page } = createPageMock();
        const first = createTempImage('a.png', makePng(1080, 1440));
        const result = await getCommand().func(page, { title: '标题', images: first, 'dry-run': true });
        expect(result[0].status).toBe('dry-run ok');
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('throws AuthRequiredError when no session token is available', async () => {
        const { page } = createPageMock({ token: undefined });
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标题', images: first }))
            .rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('falls back to the message list when the homepage has no ticket', async () => {
        const { page } = createPageMock({ html: '<html></html>' });
        const first = createTempImage('a.png', makePng(1080, 1440));
        const result = await getCommand().func(page, { title: '标题', images: first });
        expect(result[0].status).toBe('draft saved');
    });

    it('fails clearly when neither session source has a ticket', async () => {
        const { page } = createPageMock({ html: '<html></html>', messageList: {} });
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标题', images: first }))
            .rejects.toThrow(/upload session \(ticket\)/);
    });

    it('fails clearly when an image upload fails', async () => {
        const { page } = createPageMock({ uploadFails: true });
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标题', images: first }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('surfaces the 200040 duplicate-content error from the save step', async () => {
        const { page } = createPageMock({ saveResponse: { base_resp: { ret: 200040, err_msg: 'save limited' } } });
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标题', images: first }))
            .rejects.toThrow(/200040/);
    });

    it('rejects empty, too many, missing, or wrong-type images', async () => {
        const { page } = createPageMock();
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标题', images: '' })).rejects.toBeInstanceOf(ArgumentError);
        await expect(getCommand().func(page, { title: '标题', images: Array(21).fill(first).join(',') }))
            .rejects.toBeInstanceOf(ArgumentError);
        await expect(getCommand().func(page, { title: '标题', images: '/tmp/does-not-exist-12345.png' }))
            .rejects.toBeInstanceOf(ArgumentError);
        const textFile = createTempImage('note.txt', Buffer.from('not an image'));
        await expect(getCommand().func(page, { title: '标题', images: textFile }))
            .rejects.toBeInstanceOf(ArgumentError);
    });

    it('rejects an oversized image', async () => {
        const { page } = createPageMock();
        const big = createTempImage('big.png', Buffer.concat([makePng(1080, 1440), Buffer.alloc(6 * 1024 * 1024)]));
        await expect(getCommand().func(page, { title: '标题', images: big }))
            .rejects.toThrow(/6 MB/);
    });

    it('rejects a title over 64 chars and a description over 1000 chars', async () => {
        const { page } = createPageMock();
        const first = createTempImage('a.png', makePng(1080, 1440));
        await expect(getCommand().func(page, { title: '标'.repeat(65), images: first }))
            .rejects.toBeInstanceOf(ArgumentError);
        await expect(getCommand().func(page, { title: '标题', content: '描'.repeat(1001), images: first }))
            .rejects.toBeInstanceOf(ArgumentError);
    });
});
