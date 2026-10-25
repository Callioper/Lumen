// Douban's monthly book chart (book.douban.com/chart). RSSHub's /douban/book/rank reads the
// rexxar collections book_fiction/book_nonfiction, which stopped updating in 2021.
const CHART_URL = 'https://book.douban.com/chart';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
export const CHART_SUBCATS = { all: '全部', literary: '文学', novel: '小说', history: '历史文化', social: '社会纪实', tech: '科学新知', art: '艺术设计', comics: '绘本漫画' };
export const CHART_ROUTE = /^\/lumen\/douban\/book\/chart(?:\/([a-z]+))?\/?$/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENTITIES[k]);
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const text = (s) => unescape((s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const pick = (re, s) => re.exec(s)?.[1] ?? '';

export function parseChart(html, subcat = 'all') {
  const heading = text(pick(/<div class="page-header">\s*<h1>([\s\S]*?)<\/h1>/, html)) || '热门图书榜';
  // The category tabs (escaped &amp;) carry this chart's publication date; the month
  // picker's links (plain &) point at earlier charts.
  const updated = pick(/&amp;updated_at=(\d{4}-\d{2}-\d{2})/, html);
  const pubDate = updated ? new Date(`${updated}T00:00:00+08:00`).toISOString() : undefined;
  const items = html.split('<li class="media clearfix">').slice(1).map((li) => {
    const link = pick(/<a class="fleft" href="(https:\/\/book\.douban\.com\/subject\/\d+\/)"/, li);
    const title = text(pick(/<a class="fleft"[^>]*>([\s\S]*?)<\/a>/, li));
    const rank = text(pick(/<strong class="green-num-box">([\s\S]*?)<\/strong>/, li));
    const info = text(pick(/<p class="subject-abstract[^"]*">([\s\S]*?)<\/p>/, li));
    const score = text(pick(/<span class="font-small fleft">([\s\S]*?)<\/span>/, li));
    const votes = text(pick(/<span class="fleft ml8 color-gray">([\s\S]*?)<\/span>/, li));
    const cover = pick(/<img class="subject-cover"[^>]*src="([^"]+)"/, li).replace('/view/subject/s/', '/view/subject/l/');
    const tags = [...li.matchAll(/<span class="tag">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]));
    if (!link || !title) return null;
    const rating = score ? `${score}分 ${votes}` : votes;
    const description = [cover && `<img src="${escape(cover)}">`, `<p>${escape(heading)} 第 ${escape(rank)} 名</p>`,
      `<p>${escape(info)}</p>`, rating && `<p>${escape(rating)}</p>`, tags.length && `<p>${escape(tags.join(' · '))}</p>`].filter(Boolean).join('\n');
    // guid is the subject itself, so a book staying on the chart is not posted again next month.
    return { title, link, guid: link, description, pubDate, category: tags, author: info.split(' / ')[0] };
  }).filter(Boolean);
  return { title: `豆瓣${heading}-${CHART_SUBCATS[subcat] ?? subcat}`, link: `${CHART_URL}?subcat=${subcat}`, description: '豆瓣读书月度热门图书榜', item: items };
}

export async function doubanBookChart(subcat = 'all') {
  if (!Object.hasOwn(CHART_SUBCATS, subcat)) throw new Error(`not found: unknown subcat ${subcat}`);
  const res = await fetch(`${CHART_URL}?subcat=${subcat}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`douban chart ${res.status}`);
  const data = parseChart(await res.text(), subcat);
  // An empty parse means the page layout changed; fail loudly instead of serving an empty feed.
  if (!data.item.length) throw new Error('douban chart: no items parsed, page layout changed?');
  return data;
}
