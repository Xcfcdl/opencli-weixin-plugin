/**
 * weixin switch-account — 切换当前活跃的微信公众号账号。
 *
 * 核心原理：
 *   微信后台前端用 Vue 组件（window.MP_ACCOUNT_BOX）管理账号面板，
 *   切换账号 dialog 由 needShowSwitchDailog 控制。
 *   直接设 box.needShowSwitchDailog = true 触发 dialog 渲染，
 *   再点 .section-item（nickname 匹配），比 DOM click 链路稳。
 *
 * 流程：
 *   1. goto 首页，拿 token + fingerprint
 *   2. 从 switchacct 列表找目标账号（nickname 或 gh_xxx）
 *   3. 展开账号面板（点 #js_account_box）
 *   4. 设 window.MP_ACCOUNT_BOX.needShowSwitchDailog = true
 *   5. 等 .section-item 渲染（最长 20s）
 *   6. 点目标 .section-item（按 nickname 匹配 .section-item__bd 文字，
 *      当前登录账号后缀 " 当前登录" 要先去掉）
 *   7. 等 URL token 变化，验证切换成功
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

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

/** 拿当前 token、fingerprint、nick_name。 */
async function getPageContext(page) {
    const result = await evaluate(page, `(async () => {
        try {
            var response = await fetch('https://mp.weixin.qq.com/', { credentials: 'include' });
            var html = await response.text();
            var token = (html.match(/token=(\\d+)/) || window.location.href.match(/token=(\\d+)/) || [])[1] || '';
            var nickName = (html.match(/nick_name\\s*[:=]\\s*['"]([^'"]+)['"]/) || [])[1] || '';
            var fingerprint = (document.cookie.match(/_qimei_fingerprint=([^;]+)/) || [])[1] || '';
            return { ok: true, token: token, nickName: nickName, fingerprint: fingerprint };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    })()`);
    if (!result?.ok) throw new CommandExecutionError(`Could not read WeChat page context: ${result?.error}`);
    if (!result.token) throw new AuthRequiredError(WEIXIN_DOMAIN, 'Please log in to mp.weixin.qq.com and retry.');
    return result;
}

/** 从 switchacct 列表找目标账号（nickname 或 gh_xxx），返回 {username, nickname}。 */
async function findTargetAccount(page, token, fingerprint, target) {
    const fp = String(fingerprint);
    const tk = String(token);
    const targetStr = String(target);
    const result = await evaluate(page, `(async () => {
        try {
            var url = 'https://mp.weixin.qq.com/cgi-bin/switchacct?action=get_acct_list'
                + '&fingerprint=' + encodeURIComponent(${JSON.stringify(fp)})
                + '&token=' + encodeURIComponent(${JSON.stringify(tk)})
                + '&lang=zh_CN&f=json&ajax=1';
            var response = await fetch(url, { credentials: 'include' });
            var data = await response.json();
            if (!data || !data.base_resp || data.base_resp.ret !== 0) {
                return { ok: false, error: data?.base_resp?.err_msg || 'unknown' };
            }
            var biz = (data.biz_list?.list) || [];
            var wxa = (data.wxa_list?.list) || [];
            var target = ${JSON.stringify(targetStr)};
            var found = [...biz, ...wxa].find(function(item) {
                return item.username === target || (item.nickname && item.nickname === target);
            });
            if (!found) {
                var available = [...biz, ...wxa].map(function(item) {
                    return item.nickname || item.username;
                });
                return { ok: false, notFound: true, available: available };
            }
            return { ok: true, username: found.username, nickname: found.nickname || '' };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    })()`);
    if (!result?.ok) {
        if (result?.notFound) {
            throw new ArgumentError(`Account "${target}" not found. Available: ${result.available.join(', ') || '(none)'}`);
        }
        throw new CommandExecutionError(`Could not fetch account list: ${result?.error || 'unknown'}`);
    }
    return result;
}

/** 展开账号面板（点 #js_account_box）。 */
async function openAccountPanel(page) {
    await page.evaluate(`(() => {
        var box = document.querySelector('#js_account_box');
        if (box) { box.click(); return; }
        var sideItem = document.querySelector('#js_mp_sidemenu .weui-desktop-layout__side-menu__item');
        if (sideItem) sideItem.click();
    })()`);
    await page.wait(1);
}

/** 触发 switch-account dialog 渲染（设 needShowSwitchDailog）。 */
async function triggerSwitchDialog(page) {
    const result = await evaluate(page, `(() => {
        var box = window.MP_ACCOUNT_BOX;
        if (!box) return { ok: false, reason: 'MP_ACCOUNT_BOX not found' };
        box.needShowSwitchDailog = true;
        box.showPanel = false;
        return { ok: true };
    })()`);
    if (!result?.ok) {
        throw new CommandExecutionError(`Could not trigger switch dialog: ${result?.reason}`);
    }
}

/** 等 .section-item 渲染，点目标账号（nickname 匹配，去掉"当前登录"后缀）。 */
async function clickTargetAccount(page, targetNickname, oldToken) {
    const targetStr = String(targetNickname);
    let clicked = null;

    for (let attempt = 0; attempt < 10; attempt++) {
        const result = await evaluate(page, `(() => {
            var sectionItems = Array.from(document.querySelectorAll('.section-item'));
            if (sectionItems.length === 0) return { ok: false, waiting: true };
            var target = ${JSON.stringify(targetStr)};
            for (var i = 0; i < sectionItems.length; i++) {
                var bd = sectionItems[i].querySelector('.section-item__bd');
                var raw = (bd ? bd.textContent : sectionItems[i].textContent || '').trim();
                // 当前登录账号会有"  当前登录"后缀
                var clean = raw.replace(/\\s+当前登录\\s*$/, '').trim();
                if (clean === target) {
                    sectionItems[i].click();
                    return { ok: true, clicked: clean };
                }
            }
            var texts = sectionItems.map(function(el) {
                var bd = el.querySelector('.section-item__bd');
                return (bd ? bd.textContent : el.textContent || '').trim().replace(/\\s+当前登录\\s*$/, '');
            });
            return { ok: false, reason: 'target not in: ' + texts.join(', ') };
        })()`);
        if (result?.ok || result?.reason) {
            clicked = result;
            break;
        }
        await page.wait(2);
    }

    if (!clicked?.ok) {
        throw new CommandExecutionError(`Could not click target "${targetNickname}": ${clicked?.reason || 'dialog did not render'}`);
    }

    // 等页面跳转（URL token 变化）
    for (let i = 0; i < 15; i++) {
        await page.wait(2);
        const newToken = await evaluate(page, `(window.location.href.match(/token=(\\d+)/)||[])[1]`);
        if (newToken && newToken !== oldToken) {
            const newCtx = await getPageContext(page);
            return { nickName: newCtx.nickName || clicked.clicked, token: newToken };
        }
    }
    return { nickName: clicked.clicked, token: oldToken, note: 'token unchanged, verify manually' };
}

export const switchAccountCommand = cli({
    site: 'weixin',
    name: 'switch-account',
    access: 'write',
    description: '切换当前活跃的微信公众号账号（需先用 accounts 查可用账号）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'account',
            required: true,
            positional: true,
            help: '账号 nickname（如"东立有话说"）或 username（gh_xxx），先用 opencli weixin accounts 查',
        },
        { name: 'timeout', type: 'int', required: false, default: 120, help: 'Max seconds (default: 120)' },
    ],
    columns: ['status', 'detail'],

    func: async (page, kwargs) => {
        const target = kwargs.account;
        await page.goto(WEIXIN_HOME);
        await page.wait(5);

        const ctx = await getPageContext(page);
        const found = await findTargetAccount(page, ctx.token, ctx.fingerprint, target);

        // 展开面板 → 触发 dialog → 点目标
        await openAccountPanel(page);
        await triggerSwitchDialog(page);
        const result = await clickTargetAccount(page, found.nickname || found.username, ctx.token);

        return [{
            status: result.note ? 'switched (verify)' : 'switched',
            detail: `"${result.nickName}" token=${result.token}`,
        }];
    },
});
