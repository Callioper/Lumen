import Parser from 'rss-parser';

export interface Enclosure { url: string; type: string; length?: number }

export interface ParsedItem {
  guid: string;
  title: string;
  link: string;
  author: string;
  content: string;
  published: number | null;   // unix seconds
  thumbnail: string;
  enclosures: Enclosure[];
  categories: string[];
}

export interface ParsedFeed {
  title: string;
  siteUrl: string;
  description: string;
  image: string;
  items: ParsedItem[];
}

type Raw = Record<string, unknown>;

const parser = new Parser<Raw, Raw>({
  customFields: {
    feed: ['image', 'icon', 'logo'],
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:group', 'mediaGroup'],
      ['itunes:image', 'itunesImage'],
      ['dc:creator', 'dcCreator'],
      ['author', 'authorRaw'],
    ],
  },
});

const str = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === 'object') {
    const o = v as Raw;
    const a = o.$ as Raw | undefined;
    const v2 = o._ ?? o.name ?? o.url ?? o.href ?? a?.url ?? a?.href;
    return v2 === undefined ? '' : str(v2);
  }
  return String(v);
};

const attr = (v: unknown, key: string): string => {
  const o = (Array.isArray(v) ? v[0] : v) as Raw | undefined;
  return o && typeof o === 'object' ? str((o.$ as Raw | undefined)?.[key] ?? o[key]) : '';
};

function toEpoch(...cands: unknown[]): number | null {
  for (const c of cands) {
    const s = str(c);
    if (!s) continue;
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return null;
}

const FIRST_IMG = /<img[^>]+src=["']([^"']+)["']/i;

function mediaOf(it: Raw): { thumbnail: string; enclosures: Enclosure[] } {
  const enclosures: Enclosure[] = [];
  const enc = it.enclosure as Raw | undefined;
  if (enc && str(enc.url)) enclosures.push({ url: str(enc.url), type: str(enc.type), length: Number(enc.length) || undefined });
  for (const m of (it.mediaContent as unknown[] | undefined) ?? []) {
    const url = attr(m, 'url');
    if (url && !enclosures.some((e) => e.url === url)) enclosures.push({ url, type: attr(m, 'type') || attr(m, 'medium') });
  }
  const html = str(it['content:encoded']) || str(it.content);
  const thumbnail = attr(it.mediaThumbnail, 'url')
    || attr((it.mediaGroup as Raw | undefined)?.['media:thumbnail'], 'url')
    || attr(it.itunesImage, 'href')
    || enclosures.find((e) => e.type.startsWith('image'))?.url
    || html.match(FIRST_IMG)?.[1]
    || '';
  return { thumbnail, enclosures };
}

function fromXmlItem(it: Raw): ParsedItem {
  const { thumbnail, enclosures } = mediaOf(it);
  const link = str(it.link);
  const content = str(it['content:encoded']) || str(it.content) || str(it.summary) || str(it.contentSnippet);
  return {
    guid: str(it.guid) || str(it.id) || link || str(it.title),
    title: str(it.title) || '(无标题)',
    link,
    author: str(it.creator) || str(it.dcCreator) || str(it.authorRaw) || str(it.author),
    content,
    published: toEpoch(it.isoDate, it.pubDate, it.published, it.updated),
    thumbnail,
    enclosures,
    categories: ((it.categories as unknown[]) ?? []).map(str).filter(Boolean),
  };
}

function parseJsonFeed(text: string): ParsedFeed {
  const j = JSON.parse(text) as Raw;
  const items = ((j.items as Raw[]) ?? []).map((it): ParsedItem => {
    const atts = ((it.attachments as Raw[]) ?? []).map((a) => ({ url: str(a.url), type: str(a.mime_type), length: Number(a.size_in_bytes) || undefined }));
    const html = str(it.content_html) || str(it.content_text) || str(it.summary);
    return {
      guid: str(it.id) || str(it.url),
      title: str(it.title) || '(无标题)',
      link: str(it.url),
      author: str((it.authors as Raw[] | undefined)?.[0]?.name) || str((it.author as Raw | undefined)?.name),
      content: html,
      published: toEpoch(it.date_published, it.date_modified),
      thumbnail: str(it.image) || str(it.banner_image) || html.match(FIRST_IMG)?.[1] || '',
      enclosures: atts,
      categories: ((it.tags as unknown[]) ?? []).map(str),
    };
  });
  return { title: str(j.title), siteUrl: str(j.home_page_url), description: str(j.description), image: str(j.icon) || str(j.favicon), items };
}

export async function parseFeed(text: string): Promise<ParsedFeed> {
  const t = text.trimStart();
  if (t.startsWith('{')) return parseJsonFeed(t);
  if (!/^<(\?xml|rss|feed|rdf:RDF|!--)/i.test(t)) throw new Error('不是 RSS/Atom/JSON Feed（可能被重定向到网页或验证码页）');
  const f = await parser.parseString(t);
  const img = f.image as Raw | string | undefined;
  return {
    title: str(f.title),
    siteUrl: str(f.link),
    description: str(f.description),
    // A podcast often names its cover only as itunes:image.
    image: (typeof img === 'object' ? str(img?.url) : str(img)) || str(f.icon) || str(f.logo) || str((f.itunes as Raw | undefined)?.image),
    items: (f.items as Raw[]).map(fromXmlItem),
  };
}

// HTML <link rel=alternate> discovery for "add feed by site URL".
export function discoverFeedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom|feed)\+(xml|json)/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) out.push(new URL(href, base).toString());
  }
  return [...new Set(out)];
}
