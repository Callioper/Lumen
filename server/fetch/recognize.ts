// Turn a pasted page link into the feed addresses Lumen already uses for that platform, so adding a
// subscription does not need the RSSHub route or the wechat2rss id looked up by hand.
export interface Recognized { url: string; kind: string }

// A WeChat account's __biz is its numeric id in base64, and that number is the wechat2rss feed id.
function wechatBiz(u: URL): string | null {
  const inner = u.searchParams.get('target_url');
  if (inner) { try { return wechatBiz(new URL(inner)); } catch { return null; } }
  const biz = u.searchParams.get('__biz');
  if (!biz) return null;
  const id = Buffer.from(biz, 'base64').toString('latin1');
  return /^\d{6,}$/.test(id) ? id : null;
}

// wechat: the reader's wechat2rss server (设置 → 抓取), '' when there is none.
type Rule = (u: URL, wechat: URL | null) => Recognized[] | null;

const RULES: Rule[] = [
  // wechat2rss over https timed out where plain http answers.
  (u, wechat) => wechat?.protocol === 'http:' && u.host === wechat.host && u.protocol === 'https:'
    ? [{ url: 'http://' + u.host + u.pathname, kind: '公众号（wechat2rss）' }] : null,
  (u, wechat) => {
    if (u.host !== 'mp.weixin.qq.com' || !wechat) return null;
    const id = wechatBiz(u);
    return id ? [{ url: new URL(`feed/${id}.xml`, wechat).href, kind: '公众号（wechat2rss）' }] : null;
  },
  (u) => {
    const m = /^\/people\/([^/]+)/.exec(u.pathname);
    return /(^|\.)douban\.com$/.test(u.host) && m
      ? [{ url: `rsshub://douban/people/${m[1]}/status`, kind: '豆瓣广播' }] : null;
  },
  (u) => {
    const m = /^\/(?:u\/)?(\d{5,})/.exec(u.pathname);
    return /(^|\.)weibo\.(com|cn)$/.test(u.host) && m ? [{ url: `rsshub://weibo/user/${m[1]}`, kind: '微博' }] : null;
  },
  (u) => {
    const m = u.host === 'space.bilibili.com' ? /^\/(\d+)/.exec(u.pathname) : null;
    return m ? [
      { url: `rsshub://bilibili/user/dynamic/${m[1]}`, kind: 'B站动态' },
      { url: `rsshub://bilibili/user/video/${m[1]}`, kind: 'B站投稿视频' },
    ] : null;
  },
  (u) => {
    const m = /^\/podcast\/([0-9a-f]{24})/.exec(u.pathname);
    return /xiaoyuzhoufm\.com$/.test(u.host) && m ? [{ url: `rsshub://xiaoyuzhou/podcast/${m[1]}`, kind: '小宇宙播客' }] : null;
  },
  // A journal's CNKI navigation page: …/knavi/journals/BDZK/detail or …?pcode=CJFD&pykm=BDZK.
  (u) => {
    if (!/cnki\.net$/.test(u.host)) return null;
    const code = /\/journals\/([A-Z0-9]{4})\b/i.exec(u.pathname)?.[1] ?? u.searchParams.get('pykm') ?? u.searchParams.get('baseid');
    return code && /^[A-Z0-9]{4}$/i.test(code)
      ? [{ url: `https://rss.cnki.net/knavi/rss/${code.toUpperCase()}?pcode=CJFD,CCJD`, kind: '知网期刊' }] : null;
  },
];

export function recognizeSource(input: string, wechat2rss = ''): Recognized[] {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return []; }
  let wechat: URL | null = null;
  try { wechat = wechat2rss ? new URL(wechat2rss.replace(/\/*$/, '/')) : null; } catch { /* not an address: no WeChat rule */ }
  for (const rule of RULES) {
    const hit = rule(u, wechat);
    if (hit) return hit;
  }
  return [];
}
