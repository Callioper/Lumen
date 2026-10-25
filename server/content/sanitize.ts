import sanitizeHtml from 'sanitize-html';

const IFRAME_HOSTS = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.bilibili.com', 'player.vimeo.com', 'open.spotify.com'];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption', 'picture', 'source', 'video', 'audio', 'iframe', 'del', 'ins', 'sup', 'sub', 'details', 'summary', 'mark']),
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    source: ['src', 'srcset', 'type', 'media'],
    video: ['src', 'poster', 'controls', 'width', 'height'],
    audio: ['src', 'controls'],
    iframe: ['src', 'allowfullscreen', 'width', 'height'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
    '*': ['lang', 'dir'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'], a: ['http', 'https', 'mailto'] },
  allowedIframeHostnames: IFRAME_HOSTS,
  allowProtocolRelative: true,
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    // WeChat and some CMSs lazy-load via data-src; promote it.
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: attribs['data-src'] || attribs.src || '', loading: 'lazy' } }),
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && (!frame.attribs.src || frame.attribs.width === '1' || frame.attribs.height === '1'),
};

// A translated body (server/ai/translate.ts): the same rules, plus the classes that pair each
// original block with its translation.
export function sanitizeWoven(html: string): string {
  return sanitizeHtml(html, { ...OPTIONS, allowedClasses: { '*': ['tr', 'tr-src', 'tr-zh'] } });
}

export function sanitize(html: string, baseUrl?: string): string {
  let out = sanitizeHtml(html, OPTIONS);
  if (baseUrl) {
    // Resolve relative src/href so the reader (different origin) still loads them.
    out = out.replace(/\s(src|href|poster)="([^"]+)"/g, (m, k: string, v: string) => {
      if (/^(https?:|data:|mailto:|#)/i.test(v)) return m;
      try { return ` ${k}="${new URL(v.replace(/&amp;/g, '&'), baseUrl).toString().replace(/&/g, '&amp;')}"`; } catch { return m; }
    });
  }
  return out;
}

export function plainText(html: string, max = Infinity): string {
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

export function decodeEntities(s: string): string {
  return plainText(s);
}
