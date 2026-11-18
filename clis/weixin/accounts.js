/**
 * weixin accounts — 列出当前浏览器会话里所有已登录的微信账号。
 *
 * 数据来源：
 *   - 当前活跃账号：mp.weixin.qq.com/ 首页 HTML 里的 wx.commonData（user_name + nick_name）
 *   - 全部账号列表：GET /cgi-bin/switchacct?action=get_acct_list（需 _qimei_fingerprint 作 CSRF）
 *
 * 不写操作，纯只读。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const WEIXIN_DOMAIN = 'mp.weixin.qq.com';
const WEIXIN_HOME = 'https://mp.weixin.qq.com/';

function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === 'object' && typeof payload.session === 'string' && Object.hasOwn(payload, 'data')) {
        return payload.data;
    }
    return payload;
}

async function evaluate(page, script) {
    return unwrapEvaluateResult(await page.evaluate(script));
}

/**
 * 一次性拿到：token、fingerprint、当前账号（user_name + nick_name）。
 * 从首页 HTML 里解析 wx.commonData，避免 cookie 时序问题。
 */
async function getPageContext(page) {
    const result = await evaluate(page, `(async () => {
        try {
            var response = await fetch('https://mp.weixin.qq.com/', { credentials: 'include' });
            var html = await response.text();

            // 从 URL 拿 token
            var urlMatch = html.match(/token=(\\d+)/) || window.location.href.match(/token=(\\d+)/);
            var token = urlMatch ? urlMatch[1] : '';

            // 从 wx.commonData 里拿 uin（与 switchacct 列表里的 bizuin 对应）
            var uin = (html.match(/uin\\s*[:=]\\s*['"]?(\\d+)['"?]/) || [])[1] || '';
            var nickName = (html.match(/nick_name\\s*[:=]\\s*['"]([^'"]+)['"]/) || [])[1] || '';

            // 从 cookie 拿 _qimei_fingerprint（CSRF token）
            var fingerprint = (document.cookie.match(/_qimei_fingerprint=([^;]+)/) || [])[1] || '';

            return { ok: true, token: token, uin: uin, nickName: nickName, fingerprint: fingerprint };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    })()`);

    if (!result?.ok) {
        throw new CommandExecutionError(`Could not read WeChat page context: ${result?.error || 'unknown'}`);
    }
    if (!result.token) {
        throw new AuthRequiredError(WEIXIN_DOMAIN, 'Please log in to the WeChat Official Account platform and retry.');
    }
    return result;
}

/** 调 switchacct 接口拿全部账号列表（fingerprint 从 cookie 取）。 */
async function fetchAccountList(page, token, fingerprint) {
    const fp = String(fingerprint);
    const tk = String(token);
    const result = await evaluate(page, `(async () => {
        try {
            var fp = ${JSON.stringify(fp)};
            var tk = ${JSON.stringify(tk)};
            var url = 'https://mp.weixin.qq.com/cgi-bin/switchacct?action=get_acct_list'
                + '&fingerprint=' + encodeURIComponent(fp)
                + '&token=' + encodeURIComponent(tk)
                + '&lang=zh_CN&f=json&ajax=1';
            var response = await fetch(url, { credentials: 'include' });
            var data = await response.json();
            if (!data || !data.base_resp || data.base_resp.ret !== 0) {
                return { ok: false, error: (data && data.base_resp && data.base_resp.err_msg) || 'unknown' };
            }
            var biz = (data.biz_list && data.biz_list.list) || [];
            var wxa = (data.wxa_list && data.wxa_list.list) || [];
            return { ok: true, biz: biz, wxa: wxa };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    })()`);
    if (!result?.ok) {
        throw new CommandExecutionError(`Could not fetch WeChat account list: ${result?.error || 'unknown error'}`);
    }
    return { biz: result.biz, wxa: result.wxa };
}

export const accountsCommand = cli({
    site: 'weixin',
    name: 'accounts',
    access: 'read',
    description: '列出当前浏览器会话里所有已登录的微信账号（公众号 + 小程序），标注当前活跃账号',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'timeout', type: 'int', required: false, default: 60, help: 'Max seconds (default: 60)' },
    ],
    columns: ['type', 'nickname', 'username', 'is_admin', 'current', 'last_login_time'],

    func: async (page) => {
        await page.goto(WEIXIN_HOME);
        await page.wait(5);  // 等 cookie 初始化（_qimei_fingerprint 由前端 JS 设置）

        const ctx = await getPageContext(page);
        const { biz, wxa } = await fetchAccountList(page, ctx.token, ctx.fingerprint);

        const rows = [];

        for (const item of biz) {
            rows.push({
                type: 'official',
                nickname: item.nickname || '',
                username: item.username || '',
                is_admin: item.is_admin === 1 ? 'yes' : 'no',
                current: ctx.nickName && item.nickname === ctx.nickName ? '●' : '',
                last_login_time: item.last_login_time
                    ? new Date(item.last_login_time * 1000).toISOString().replace('T', ' ').slice(0, 19)
                    : '',
            });
        }

        for (const item of wxa) {
            rows.push({
                type: 'mini',
                nickname: item.nickname || '',
                username: item.username || '',
                is_admin: item.is_admin === 1 ? 'yes' : 'no',
                current: '',
                last_login_time: item.last_login_time
                    ? new Date(item.last_login_time * 1000).toISOString().replace('T', ' ').slice(0, 19)
                    : '',
            });
        }

        return rows;
    },
});
