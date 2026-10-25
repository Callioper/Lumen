// How to get into an online event, read by rule from its post: the meeting number and password where
// the post prints them, the links to a Zoom or 腾讯会议 registration or a live room, and the B站
// account that streams it. The AI's `live` says only 「腾讯会议；B站账号」 for most: the posts of
// study clubs and the like never print the number (it goes to those who sign up), so a number is shown only
// where there is one, and an account named, not linked, is searched for on B站 by its name.

export interface LiveLink { label: string; url: string }
export interface LiveAccess { meeting: string; links: LiveLink[] }

const NUMBER = String.raw`(\d{3}[\s-]?\d{3}[\s-]?\d{3,4})`;
const TENCENT = new RegExp(String.raw`(?:腾讯会议|会议号|会议\s*ID)[^0-9\n]{0,10}` + NUMBER, 'i');
const ZOOM = new RegExp(String.raw`Zoom[^\n]{0,20}?(?:ID|会议号)[^0-9\n]{0,4}` + NUMBER, 'i');
const PASSWORD = /(?:会议)?密码\s*[:：]?\s*([0-9A-Za-z]{4,10})/;
const URL_IN = /https?:\/\/[^\s<>"'，。；、）)\]]+/g;
const HOSTS: [RegExp, string][] = [
  [/zoom\.(us|com)/, 'Zoom'], [/meeting\.tencent\.com|voovmeeting/, '腾讯会议'],
  [/live\.bilibili\.com/, 'B站直播间'], [/bilibili\.com|b23\.tv/, 'B站'],
  [/channels\.weixin\.qq\.com/, '视频号'],
];
// 「松溪读书会B站号」「远川的B站直播间」: the name just before B站.
const BILI_NAME = /([\p{Script=Han}A-Za-z0-9·]{2,12}?)的?\s*(?:B站|哔哩哔哩|bilibili)/u;
const BILI = /B站|哔哩哔哩|bilibili/i;
const CHANNEL_NAME = /([\p{Script=Han}A-Za-z0-9·]{2,12}?)的?\s*(?:微信)?视频号/u;
const MAX_ACCOUNTS = 4;
const NOT_A_NAME =/^(?:同步|直播|线上|以及|和|及|微信|在|通过|进行)/;

const fix = (url: string): string => url.replace(/[‐-―]/g, '-');      // WeChat's hyphens in a pasted link
const spaced = (n: string): string => n.replace(/[\s-]/g, '').replace(/^(\d{3})(\d{3})(\d+)$/, '$1 $2 $3');
const nameOf = (re: RegExp, s: string): string => {
  const m = re.exec(s)?.[1]?.trim() ?? '';
  return m && !NOT_A_NAME.test(m) ? m : '';
};

export function liveAccess(text: string, live: string, organizer: string): LiveAccess {
  const tencent = TENCENT.exec(text)?.[1];
  const zoom = ZOOM.exec(text)?.[1];
  const password = (tencent || zoom) ? PASSWORD.exec(text)?.[1] : undefined;
  const meeting = [tencent && `腾讯会议 ${spaced(tencent)}`, zoom && `Zoom ${spaced(zoom)}`, password && `密码 ${password}`].filter(Boolean).join('，');
  const links: LiveLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(URL_IN) ?? []) {
    const url = fix(raw);
    const kind = HOSTS.find(([re]) => re.test(url));
    if (kind && !seen.has(url)) { seen.add(url); links.push({ label: kind[1], url }); }
  }
  // A B站 stream with no link: its accounts, by the names the post gives (一生所念 streamed on three
  // speakers' accounts at once), else the channel's, else the organizer's.
  if (BILI.test(`${live}\n${text}`) && !links.some((l) => l.label.startsWith('B站'))) {
    const lines = [live, ...text.split('\n').filter((l) => BILI.test(l))];
    const named = [...new Set(lines.flatMap((l) => l.split(/[、，,；;]/)).map((l) => nameOf(BILI_NAME, l)).filter(Boolean))].slice(0, MAX_ACCOUNTS);
    const names = named.length ? named
      : [lines.map((l) => nameOf(CHANNEL_NAME, l)).find(Boolean) || organizer.split(/[、，,；;\s]/)[0]].filter(Boolean);
    for (const name of names) links.push({ label: `B站 · ${name}`, url: `https://search.bilibili.com/upuser?keyword=${encodeURIComponent(name)}` });
  }
  return { meeting, links };
}
