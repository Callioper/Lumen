// The 豆瓣 subject pages a book's or a film's card opens in the demo (scripts/demo/seed.ts), invented:
// the info block, a rating, an introduction and a few short comments, as server/content/douban.ts and
// doubanmovie.ts keep a real one.
import type { Book } from './content.ts';

const READERS = ['松果', '北窗', '小满', '河口的鱼', '半夏', '读书的猫', '西岭', '晚照'];
const BOOK_SAYS = ['读得很慢，但每一章都有收获。', '材料扎实，结论克制，难得。', '前半本比后半本好。', '适合在通勤路上读，一次一章。',
  '翻译流畅，注释很用心。', '把一个小题目写出了大格局。', '想推荐给所有做这个方向的朋友。'];
const FILM_SAYS = ['镜头很安静，看完很久说不出话。', '剧本一般，摄影很好。', '适合一个人在下雨天看。', '比预告片好太多。', '结尾有点仓促。'];

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 99991, 7);
const comments = (title: string, says: readonly string[]) => [0, 1, 2, 3].map((k) => {
  const h = hash(title + k);
  return { who: READERS[(h + k) % READERS.length], stars: 3 + (h % 3), time: `2026-10-${String(1 + (h % 23)).padStart(2, '0')}`, text: says[(h + k * 2) % says.length], votes: 40 - k * 9 + (h % 7) };
});

export function book(title: string, b: Book | undefined, cover: string) {
  const h = hash(title);
  const fields: [string, string][] = b
    ? [['作者', b.authors.replace(/ ?[著编]$/, '')], ...(b.translators ? [['译者', b.translators.replace(/ ?译$/, '')] as [string, string]] : []),
      ['出版社', b.publisher], ...(b.original ? [['原作名', b.original] as [string, string]] : []), ['出版年', b.date.replace(/年(\d+)月/, '-$1')],
      ['定价', b.price], ...(b.series ? [['丛书', b.series] as [string, string]] : []), ['ISBN', b.isbn]]
    : [['作者', '佚名'], ['出版社', '远川书局'], ['出版年', '2026']];
  return {
    title, cover, fields, rating: Math.round((7.4 + (h % 17) / 10) * 10) / 10, votes: 300 + (h % 4000),
    doing: 40 + (h % 300), done: 300 + (h % 4000), wish: 900 + (h % 9000),
    intro: [b?.blurb ?? '一本虚构的书。', '本书为 Lumen 演示站虚构，书名、作者、出版社与内容简介均不对应任何真实出版物。'],
    authorIntro: [`${(b?.authors ?? '佚名').replace(/ ?[著编]$/, '')}，虚构人物，演示用。`],
    toc: ['序', '第一章　起点', '第二章　材料', '第三章　转折', '结语', '后记'],
    comments: comments(title, BOOK_SAYS), commentTotal: 40 + (h % 900), reviewTotal: 3 + (h % 40),
  };
}

export function film(title: string, cover: string) {
  const h = hash(title);
  return {
    title, original: '', aka: [], year: '2026', cover, pubdate: ['2026-09-12(中国大陆)'], durations: [`${88 + (h % 50)}分钟`],
    countries: ['中国大陆'], languages: ['汉语普通话'], genres: [['纪录片', '剧情', '家庭'][h % 3]],
    directors: [READERS[h % READERS.length]], actors: [READERS[(h + 2) % READERS.length], READERS[(h + 5) % READERS.length]],
    isTv: false, episodes: 0, rating: Math.round((7 + (h % 20) / 10) * 10) / 10, votes: 2000 + (h % 30000),
    intro: ['一部虚构的电影，演示用。', '片名、演职员与剧情均不对应任何真实作品。'],
    comments: comments(title, FILM_SAYS), commentTotal: 300 + (h % 5000), reviewTotal: 10 + (h % 200),
  };
}
