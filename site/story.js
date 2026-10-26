// The chaptered home page (index.html): which chapter is showing, where the scene sits in it, and the 学术动态
// chapter's demo, played step by step. A step is a change of the scene's state (world.dataset.s and a few classes),
// which the CSS transitions animate, plus words flying from the post to the card it becomes.
(() => {
  const stage = document.getElementById('stage');
  const world = document.getElementById('world');
  const copies = [...stage.querySelectorAll('.copy')];
  const links = [...document.querySelectorAll('[data-go]')];
  const status = document.querySelector('.way-status');
  const pauseBtn = document.querySelector('.way-pause');
  const hint = document.querySelector('.way-hint');
  const arrows = [...document.querySelectorAll('.way-arrow')];
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  const CHAPTERS = [
    { hash: 'top', name: '众声纷至，条分缕析' },
    { hash: 'notices', name: '学术动态：会议截止，一目了然' },
    { hash: 'books', name: '新书：一篇书单，本本分明' },
    { hash: 'journals', name: '期刊目录：分篇推送，合为一期' },
    { hash: 'daily', name: '日报：每日一报，择要而读' },
    { hash: 'search', name: '外文与检索：外文径读，以意相求' },
    { hash: 'open', name: '藏之本机，公诸同好' },
  ];
  // The part of the 920×560 scene each chapter shows, which is what gets fitted into the room the copy leaves.
  const CONTENT = [
    { x: -170, y: -40, w: 1260, h: 400, max: 1.25 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
    { x: 0, y: 0, w: 920, h: 556, max: 1.22 },
  ];
  // On a phone the scene stacks instead (story.css .world.narrow): the posts as a deck, the table under the post.
  const NARROW = [
    { x: 290, y: -12, w: 340, h: 490, max: 1.2 },
    { x: 0, y: 0, w: 580, h: 920, max: 1 },
    { x: 0, y: 0, w: 580, h: 830, max: 1 },
    { x: 0, y: 0, w: 580, h: 960, max: 1 },
    { x: 0, y: 0, w: 580, h: 1000, max: 1 },
    { x: 0, y: 0, w: 580, h: 800, max: 1 },
    { x: 0, y: 0, w: 920, h: 556, max: 1 },
  ];
  const isNarrow = () => stage.clientWidth < 640;

  let ch = 0;
  let paused = false;
  let run = 0; // bumped to cancel whatever the demo was doing

  // ── Waiting that stops while paused, and gives up when the demo is restarted ──
  const CANCEL = Symbol('cancel');
  const sleep = (ms) => new Promise((resolve, reject) => {
    const mine = run;
    let left = ms;
    let last = performance.now();
    const tick = (now) => {
      if (mine !== run) return reject(CANCEL);
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const motion = () => stage.getAnimations({ subtree: true });

  // ── Placing the scene ──
  const WIDE = 1400; // the page's measure, as story.css has it for the bars
  const gutter = () => Math.max(16, Math.min(40, innerWidth * 0.04));
  function roomFor(n) {
    const W = stage.clientWidth, H = stage.clientHeight, g = gutter();
    const c = copies[n];
    if (n === 0) {
      const top = c.offsetTop + c.offsetHeight + Math.min(56, H * 0.06);
      const cap = W < 640 ? 76 : 48;
      return { x: g, y: top, w: W - 2 * g, h: Math.max(120, H - top - cap) };
    }
    if (W >= 980) {
      const left = Math.max(g, (W - WIDE) / 2);
      stage.style.setProperty('--copy-x', `${left}px`);
      const x = left + 340 + Math.min(72, W * 0.04);
      return { x, y: 24, w: Math.min(W - g, left + WIDE) - x, h: H - 48 };
    }
    const top = c.offsetTop + c.offsetHeight + 18;
    return { x: g, y: top, w: W - 2 * g, h: Math.max(160, H - top - 14) };
  }
  function place(n) {
    const narrow = isNarrow();
    world.classList.toggle('narrow', narrow);
    const room = roomFor(n), box = (narrow ? NARROW : CONTENT)[n];
    const s = Math.min(room.w / box.w, room.h / box.h, box.max);
    world.style.setProperty('--bs', s.toFixed(4));
    world.style.setProperty('--bx', `${(room.x + (room.w - box.w * s) / 2 - box.x * s).toFixed(1)}px`);
    world.style.setProperty('--by', `${(room.y + (room.h - box.h * s) / 2 - box.y * s).toFixed(1)}px`);
  }

  // ── 日期 ──
  // The page is written as it reads on 10月27日; data-at says how many days from today each date is, so the
  // countdowns stay true whenever it is opened. data-fmt="post" spells it the way a 公众号 post does.
  (function dated() {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const day = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    for (const el of document.querySelectorAll('[data-at]')) {
      const [a, b] = el.dataset.at.split('-').map(Number);
      const fmt = el.dataset.fmt || '';
      const sp = fmt.startsWith('post') ? ' ' : '';
      const md = (d) => `${d.getMonth() + 1}${sp}月${sp}${d.getDate()}${sp}日`;
      const d0 = day(a);
      let s = md(d0);
      if (b !== undefined) {
        const d1 = day(b);
        s += (sp ? '至 ' : '–') + (d1.getMonth() === d0.getMonth() ? `${d1.getDate()}${sp}日` : md(d1));
      }
      el.textContent = fmt === 'post-y' ? `${d0.getFullYear()} 年 ${s}` : s;
    }
  })();

  // ── The 学术动态 scene's states ──
  // s 0: the post and four notices. 1: the post read, a new card drafted on top. 2: the card in its place by
  // deadline. 3: a second account's post about the same meeting, merged into that card.
  const postA = world.querySelector('.post-a');
  const postB = world.querySelector('.post-b');
  const marksA = [...postA.querySelectorAll('mark')];
  const markB = postB.querySelector('mark');
  const rows = Object.fromEntries([...world.querySelectorAll('.nt')].map((li) => [li.dataset.id, li]));
  const fresh = rows.new;
  const fills = [...fresh.querySelectorAll('.fill')];
  const dup = fresh.querySelector('.nt-dup');
  const count = world.querySelector('.board-count i');
  const ROW = 84; // a 74px card and its gap
  const DRAFT_GAP = 14;

  function lay(s) {
    const sorted = s >= 2 ? ['ws', 'sb', 'new', 'zp', 'zj'] : ['ws', 'sb', 'zp', 'zj'];
    const order = s === 1 ? ['new', ...sorted] : sorted;
    order.forEach((id, i) => {
      const extra = s === 1 && id !== 'new' ? DRAFT_GAP : 0;
      rows[id].style.setProperty('--y', `${i * ROW + extra}px`);
    });
    if (s === 0) { fresh.style.setProperty('--y', '0px'); fresh.style.setProperty('--sc', '0.96'); fresh.style.setProperty('--o', '0'); }
    else { fresh.style.setProperty('--sc', '1'); fresh.style.setProperty('--o', '1'); }
    fresh.classList.toggle('draft', s === 1);
    if (s < 2) fresh.classList.remove('landed');
    const n = s >= 2 ? '5' : '4';
    if (count.textContent !== n) {
      count.textContent = n;
      if (s >= 2) { count.classList.remove('bump'); void count.offsetWidth; count.classList.add('bump'); }
    }
  }
  // The scene as it stands after a step, with no words in flight: what a jump, a reset or a still page shows.
  function settle(s, { instant = false } = {}) {
    if (instant) world.classList.add('instant');
    world.dataset.s = String(s);
    lay(s);
    for (const m of marksA) m.classList.toggle('on', s >= 1);
    markB.classList.toggle('on', s >= 3);
    for (const f of fills) f.classList.toggle('on', s >= 1);
    dup.classList.toggle('on', s >= 3);
    postB.classList.toggle('merged', s >= 3);
    fresh.classList.remove('moving', 'landed');
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }
  }

  // Where an element is, in the scene's own (unscaled) pixels.
  function spot(el) {
    const w = world.getBoundingClientRect(), r = el.getBoundingClientRect();
    const s = w.width / world.offsetWidth;
    return { x: (r.left - w.left) / s, y: (r.top - w.top) / s, w: r.width / s, h: r.height / s };
  }
  // A copy of the words leaves `from`, arcs over, and lands on `to`, which fills in as it arrives.
  const FLY = 720;
  async function fly(from, to, { text = from.textContent, chip = false, then } = {}) {
    const a = spot(from), b = spot(to);
    const f = document.createElement('span');
    f.className = chip ? 'flyer chip' : 'flyer';
    f.textContent = text;
    world.append(f);
    const fw = f.offsetWidth, fh = f.offsetHeight;
    const x0 = a.x + (a.w - fw) / 2, y0 = a.y + (a.h - fh) / 2;
    const x1 = b.x + (b.w - fw) / 2, y1 = b.y + (b.h - fh) / 2;
    const k = Math.min(1.1, Math.max(0.7, b.h / fh));
    const lift = Math.min(90, 30 + Math.abs(x1 - x0) * 0.12);
    const anim = f.animate([
      { transform: `translate(${x0}px, ${y0}px) scale(0.92)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0 - 6}px) scale(1.04)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) scale(1.06)`, offset: 0.55 },
      { transform: `translate(${x1}px, ${y1}px) scale(${k})`, opacity: 1, offset: 0.9 },
      { transform: `translate(${x1}px, ${y1}px) scale(${k})`, opacity: 0 },
    ], { duration: FLY, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'forwards' });
    if (paused) anim.pause();
    try {
      await sleep(FLY * 0.88);
      to.classList.add('on');
      then?.();
      await sleep(FLY * 0.12);
    } finally {
      f.remove();
    }
  }

  // A chapter's demo: its steps, each from the state before it to the state after; how long each step's rule
  // takes to fill (the step and the pause after it); settle(s), the scene after s steps; and the step buttons.
  const NOTICES = { settle, items: [...copies[1].querySelectorAll('.steps li')], steps: [
    async function read() {
      settle(0);
      for (const f of fills) f.classList.remove('on');
      world.dataset.s = '1';
      lay(1);
      await sleep(520);
      const order = ['name', 'due', 'date', 'place', 'org'];
      const flights = [];
      for (const key of order) {
        const m = marksA.find((x) => x.dataset.f === key);
        m.classList.add('on');
        await sleep(170);
        const target = fills.find((x) => x.dataset.f === key);
        const left = fills.find((x) => x.dataset.f === 'left');
        const flight = fly(m, target, key === 'due' ? { text: target.textContent, then: () => setTimeout(() => left.classList.add('on'), 220) } : {});
        flight.catch(() => {}); // a restart cancels the ones still in the air; Promise.all below reports it once
        flights.push(flight);
        await sleep(190);
      }
      await Promise.all(flights);
      await sleep(160);
      fills.find((x) => x.dataset.f === 'kind').classList.add('on');
    },
    async function sort() {
      // Lifted while it moves, so it passes over the cards it overtakes instead of through them.
      fresh.classList.add('moving');
      world.dataset.s = '2';
      lay(2);
      await sleep(720);
      fresh.classList.remove('moving');
      fresh.classList.add('landed');
      await sleep(650);
      fresh.classList.remove('landed');
    },
    async function merge() {
      world.dataset.s = '3';
      await sleep(850);
      markB.classList.add('on');
      await sleep(420);
      await fly(postB.querySelector('.post-head'), dup, { text: '媒介研究前沿 · 一号通知', chip: true, then: () => dup.classList.add('on') });
      postB.classList.add('merged');
    },
  ], ms: [3900, 2200, 2800] };

  // ── The 新书 scene ──
  // s 0: the 书单 post, and the shelf with last month's books. 1: the post's four books shelved under 十月.
  // 2: the one already in Zotero marked.
  const minis = [...world.querySelectorAll('.post-c .covers .book')];
  const wall = world.querySelector('.wall');
  const newSlots = [...wall.querySelectorAll('.shelf-new .slot')];
  const oldSlots = [...wall.querySelectorAll('.shelf-old .slot')];
  // The shelf shows the same covers as the post and the pile, so it is filled from them rather than written twice.
  const shelved = minis.map((b, i) => newSlots[i].insertBefore(b.cloneNode(true), newSlots[i].firstChild));
  world.querySelectorAll('.bk').forEach((b, i) => {
    const c = b.cloneNode(true);
    c.className = [...b.classList].filter((k) => k === 'book' || k.startsWith('v-')).join(' ');
    oldSlots[i].append(c);
  });
  const ownedSlot = wall.querySelector('.slot.has');
  const ownedTag = ownedSlot.querySelector('.owned-tag');
  const wallCount = wall.querySelector('.board-count i');
  const wallOwned = wall.querySelector('.wall-owned');
  function settleBooks(s, { instant = false } = {}) {
    if (instant) world.classList.add('instant');
    world.dataset.s = String(s);
    minis.forEach((b) => b.classList.toggle('taken', s >= 1));
    shelved.forEach((b) => b.classList.toggle('in', s >= 1));
    wallCount.textContent = s >= 1 ? '8' : '4';
    ownedSlot.classList.toggle('owned', s >= 2);
    ownedTag.classList.toggle('on', s >= 2);
    wallOwned.classList.toggle('on', s >= 2);
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }
  }
  // A cover leaves the post at its small size and lands on the shelf at full size.
  async function flyCover(from, to) {
    const a = spot(from), b = spot(to.parentNode);
    const f = to.cloneNode(true);
    f.classList.add('flyer-book', 'in');
    f.style.width = `${b.w}px`;
    world.append(f);
    const k = a.w / b.w;
    const lift = Math.min(80, 30 + Math.abs(b.x - a.x) * 0.1);
    const anim = f.animate([
      { transform: `translate(${a.x}px, ${a.y}px) scale(${k})` },
      { transform: `translate(${(a.x + b.x) / 2}px, ${Math.min(a.y, b.y) - lift}px) scale(${(k + 1) / 2})`, offset: 0.5 },
      { transform: `translate(${b.x}px, ${b.y}px) scale(1)` },
    ], { duration: FLY, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'forwards' });
    if (paused) anim.pause();
    try {
      await sleep(FLY);
      to.classList.add('in');
    } finally {
      f.remove();
    }
  }
  const BOOKS = { settle: settleBooks, items: [...copies[2].querySelectorAll('.steps li')], steps: [
    async function split() {
      settleBooks(0);
      await sleep(300);
      const flights = [];
      for (let i = 0; i < minis.length; i++) {
        minis[i].classList.add('taken');
        const flight = flyCover(minis[i], shelved[i]);
        flight.catch(() => {}); // as in read(): Promise.all below reports a restart once
        flights.push(flight);
        await sleep(300);
      }
      await Promise.all(flights);
      world.dataset.s = '1';
      wallCount.textContent = '8';
      wallCount.classList.remove('bump'); void wallCount.offsetWidth; wallCount.classList.add('bump');
    },
    async function mark() {
      await sleep(300);
      ownedSlot.classList.add('owned');
      ownedTag.classList.add('on');
      await sleep(350);
      wallOwned.classList.add('on');
      world.dataset.s = '2';
    },
  ], ms: [3000, 1500] };

  // ── The 期刊目录 scene ──
  // s 0: the issue's first half, from yesterday's post; today's post with the second half. 1: the second half in its
  // rows, the issue whole. 2: the 人大复印 reprint of one article marked on its row.
  const tocp = world.querySelector('.tocp');
  const halfSrc = [...world.querySelectorAll('.post-e .toc-src li')];
  const lateRows = [...tocp.querySelectorAll('.tr.late')];
  const lateFills = [...tocp.querySelectorAll('.tr.late .fill')];
  const rpSrc = world.querySelector('.rp-src');
  const rpRow = tocp.querySelector('.rp-row');
  const rpTag = tocp.querySelector('.rp-tag');
  const tocCount = tocp.querySelector('.board-count i');
  const tocHalf = tocp.querySelector('.toc-half');
  const whole = (on) => { tocHalf.classList.toggle('whole', on); tocHalf.textContent = on ? '整期' : '上半期'; tocCount.textContent = on ? '8' : '4'; };
  function settleToc(s, { instant = false } = {}) {
    if (instant) world.classList.add('instant');
    for (const f of lateFills) f.classList.toggle('on', s >= 1);
    for (const li of halfSrc) li.classList.toggle('sent', s >= 1);
    whole(s >= 1);
    rpSrc.classList.toggle('on', s >= 2);
    rpTag.classList.toggle('on', s >= 2);
    rpRow.classList.toggle('rp', s >= 2);
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }
  }
  const bump = (el) => { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); };
  const JOURNALS = { settle: settleToc, items: [...copies[3].querySelectorAll('.steps li')], steps: [
    async function merge() {
      settleToc(0);
      await sleep(300);
      const flights = [];
      for (let i = 0; i < halfSrc.length; i++) {
        halfSrc[i].classList.add('sent');
        await sleep(120);
        const row = lateRows[i];
        const flight = fly(halfSrc[i].querySelector('b'), row.querySelector('.tt'), { then: () => row.querySelectorAll('.fill').forEach((f) => f.classList.add('on')) });
        flight.catch(() => {}); // as in read()
        flights.push(flight);
        await sleep(200);
      }
      await Promise.all(flights);
      whole(true);
      bump(tocCount);
    },
    async function reprint() {
      await sleep(300);
      rpSrc.classList.add('on');
      await sleep(300);
      await fly(rpSrc, rpTag, { text: '人大复印', chip: true });
      rpRow.classList.add('rp');
    },
  ], ms: [2700, 1900] };

  // ── The 日报 scene ──
  // s 0: yesterday's arrivals, the report's slots empty. 1: the noise dimmed, the picks in their slots, the overview
  // written. 2: one pick from outside the reader's usual run, as 破茧.
  const report = world.querySelector('.report');
  const arrivals = [...world.querySelectorAll('.inbox .ib')];
  const picks = arrivals.filter((li) => li.dataset.pick);
  const noise = arrivals.filter((li) => !li.dataset.pick && !li.classList.contains('explore'));
  const odd = world.querySelector('.inbox .explore');
  const slots = [...report.querySelectorAll('.rr')];
  const overview = report.querySelector('.rp-over');
  const exCard = report.querySelector('.ex-card');
  const pickCount = report.querySelector('.board-count i');
  function settleDaily(s, { instant = false } = {}) {
    if (instant) world.classList.add('instant');
    for (const li of noise) li.classList.toggle('out', s >= 1);
    for (const li of picks) li.classList.toggle('sent', s >= 1);
    for (const f of report.querySelectorAll('.rr .fill')) f.classList.toggle('on', s >= 1);
    overview.classList.toggle('on', s >= 1);
    pickCount.textContent = s >= 2 ? '5' : s >= 1 ? '4' : '0';
    odd.classList.toggle('sent', s >= 2);
    exCard.classList.toggle('on', s >= 2);
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }
  }
  const DAILY = { settle: settleDaily, items: [...copies[4].querySelectorAll('.steps li')], steps: [
    async function pick() {
      settleDaily(0);
      await sleep(300);
      for (const li of noise) { li.classList.add('out'); await sleep(70); }
      await sleep(250);
      const flights = [];
      for (const li of picks) {
        li.classList.add('sent');
        const slot = slots[Number(li.dataset.pick)];
        const flight = fly(li.querySelector('b'), slot.querySelector('b'), { then: () => slot.querySelector('small').classList.add('on') });
        flight.catch(() => {});
        flights.push(flight);
        pickCount.textContent = String(flights.length);
        await sleep(240);
      }
      await Promise.all(flights);
      overview.classList.add('on');
      bump(pickCount);
    },
    async function explore() {
      await sleep(300);
      odd.classList.add('sent');
      await sleep(350);
      exCard.classList.add('on');
      pickCount.textContent = '5';
      bump(pickCount);
    },
  ], ms: [3000, 1500] };

  // ── The 外文与检索 scene ──
  // s 0: a foreign journal's titles as they come. 1: read in Chinese, the original kept underneath. 2: a search for
  // 骑手 that also finds what is about the same thing in other words.
  const enRows = [...world.querySelectorAll('.en-row')];
  const search = world.querySelector('.search');
  const query = search.querySelector('.q');
  const seg = search.querySelector('.seg');
  const results = [...search.querySelectorAll('.sr')];
  const sCount = search.querySelector('.s-count');
  function settleSearch(s, { instant = false } = {}) {
    if (instant) world.classList.add('instant');
    for (const r of enRows) r.classList.toggle('zh', s >= 1);
    search.classList.remove('typing');
    query.textContent = s >= 2 ? '骑手' : '';
    seg.classList.toggle('near', s >= 2);
    for (const r of results) r.classList.toggle('in', s >= 2);
    sCount.textContent = s >= 2 ? '3 篇' : '';
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }
  }
  const SEARCH = { settle: settleSearch, items: [...copies[5].querySelectorAll('.steps li')], steps: [
    async function translate() {
      settleSearch(0);
      await sleep(400);
      for (const r of enRows) { r.classList.add('zh'); await sleep(380); }
    },
    async function find() {
      search.classList.add('typing');
      await sleep(350);
      query.textContent = '骑';
      await sleep(220);
      query.textContent = '骑手';
      await sleep(350);
      search.classList.remove('typing');
      results[0].classList.add('in');
      sCount.textContent = '1 篇';
      await sleep(800);
      seg.classList.add('near');
      await sleep(350);
      for (const r of results.slice(1)) { r.classList.add('in'); await sleep(200); }
      sCount.textContent = '3 篇';
    },
  ], ms: [2200, 3000] };

  const DEMOS = { 1: NOTICES, 2: BOOKS, 3: JOURNALS, 4: DAILY, 5: SEARCH };
  const GATHERED = 6; // the last chapter shows what the others made, each at its end
  const HOLD = 800;
  let demo = null; // the one playing, or showing its end

  function markStep(k) {
    if (!demo) return;
    const stepItems = demo.items;
    stepItems.forEach((li, i) => {
      li.classList.toggle('done', k >= 0 && i < k);
      li.classList.remove('now');
      li.style.removeProperty('--dur');
    });
    const li = stepItems[k];
    if (!li) return; // -1: none yet; past the last: all done
    void li.offsetWidth;
    li.style.setProperty('--dur', `${demo.ms[k]}ms`);
    li.classList.add('now');
  }

  // `lead`: how long the scene stands still first, which is the chapter's own entrance when it has just opened.
  async function play(d, from = 0, lead = 0) {
    const mine = ++run;
    demo = d;
    for (const f of world.querySelectorAll('.flyer, .flyer-book')) f.remove();
    const STEPS = d.steps;
    try {
      d.settle(from, { instant: from > 0 });
      if (from === 0) markStep(-1);
      await sleep(lead);
      for (;;) {
        for (let k = from; k < STEPS.length; k++) {
          markStep(k);
          await STEPS[k]();
          await sleep(HOLD);
        }
        markStep(STEPS.length);
        await sleep(2400);
        // Back to the start, the way it came: what the steps brought goes again.
        markStep(-1);
        d.settle(0);
        await sleep(1000);
        from = 0;
      }
    } catch (e) {
      if (e !== CANCEL) throw e;
    } finally {
      if (mine === run) markStep(-1);
    }
  }
  function stop() {
    run++;
    for (const f of world.querySelectorAll('.flyer, .flyer-book')) f.remove();
  }

  // ── Chapters ──
  function show(n, { instant = false } = {}) {
    n = Math.max(0, Math.min(CHAPTERS.length - 1, n));
    const dir = n >= ch ? 1 : -1;
    const was = ch;
    ch = n;
    stage.dataset.ch = String(n);
    copies.forEach((c, i) => {
      if (i === n) {
        if (!c.classList.contains('on')) {
          c.classList.add('instant');
          c.style.setProperty('--off', `${24 * dir}px`);
          void c.offsetWidth;
          c.classList.remove('instant');
          c.classList.add('on');
        }
      } else if (c.classList.contains('on')) {
        c.style.setProperty('--off', `${-24 * dir}px`);
        c.classList.remove('on');
      }
    });
    links.forEach((a, i) => (i === n ? a.setAttribute('aria-current', 'step') : a.removeAttribute('aria-current')));
    arrows[0].disabled = n === 0;
    arrows[1].disabled = n === CHAPTERS.length - 1;
    status.textContent = CHAPTERS[n].name;
    pauseBtn.hidden = !DEMOS[n] || still.matches;
    hint.hidden = n !== 0;
    if (location.hash.slice(1) !== CHAPTERS[n].hash) history.replaceState(null, '', `#${CHAPTERS[n].hash}`);

    stop();
    if (instant) world.classList.add('instant');
    world.dataset.ch = String(n);
    // Which parts of a post show, by chapter: data-in lists the chapters a fold is open in.
    for (const p of world.querySelectorAll('.fold[data-in]')) p.classList.toggle('open', p.dataset.in.split(' ').includes(String(n)));
    place(n);
    if (instant) { void world.offsetWidth; world.classList.remove('instant'); }

    if (DEMOS[was] && was !== n) { markStep(-1); DEMOS[was].settle(0); demo = null; }
    if (was === GATHERED && n !== GATHERED) for (const k of [1, 2, 3, 4]) DEMOS[k].settle(0, { instant: true });
    if (n === GATHERED) for (const k of [1, 2, 3, 4]) DEMOS[k].settle(DEMOS[k].steps.length, { instant: true });
    const d = DEMOS[n];
    if (d) {
      if (still.matches) { demo = d; d.settle(d.steps.length, { instant: true }); }
      else play(d, 0, 800);
    }
  }

  // ── Getting around: wheel, keys, swipes, the bar, the address ──
  let lockUntil = 0;
  let wheelSum = 0;
  let wheelAt = 0;
  const go = (d) => {
    const now = performance.now();
    if (now < lockUntil) return;
    const next = Math.max(0, Math.min(CHAPTERS.length - 1, ch + d));
    if (next === ch) return;
    lockUntil = now + 950;
    show(next);
  };
  // One gesture, one chapter: a trackpad's flick keeps sending wheel events for a second or more after the
  // fingers lift, so after a turn the wheel has to fall quiet before it can turn again.
  let wheelArmed = true;
  addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    const now = performance.now();
    if (now - wheelAt > 220) { wheelSum = 0; wheelArmed = true; }
    wheelAt = now;
    if (!wheelArmed) return;
    wheelSum += e.deltaY;
    if (Math.abs(wheelSum) > 50) { go(Math.sign(wheelSum)); wheelSum = 0; wheelArmed = false; }
  }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea')) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.target.closest?.('button, a'))) { e.preventDefault(); go(1); }
    else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(-1); }
    else if (k === 'Home') show(0);
    else if (k === 'End') show(CHAPTERS.length - 1);
  });
  let touchY = null;
  addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (touchY === null) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 48) go(Math.sign(dy));
  }, { passive: true });
  links.forEach((a, i) => a.addEventListener('click', (e) => { e.preventDefault(); show(i); }));
  arrows.forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.dir))));
  addEventListener('hashchange', () => {
    const i = CHAPTERS.findIndex((c) => c.hash === location.hash.slice(1));
    if (i >= 0 && i !== ch) show(i);
  });

  for (const [n, d] of Object.entries(DEMOS)) {
    d.items.forEach((li, k) => li.querySelector('button').addEventListener('click', () => {
      if (ch !== Number(n)) return;
      if (paused) setPaused(false);
      play(d, k);
    }));
  }
  function setPaused(p) {
    paused = p;
    pauseBtn.textContent = p ? '继续演示' : '暂停演示';
    pauseBtn.setAttribute('aria-pressed', String(p));
    for (const a of motion()) {
      if (a instanceof CSSAnimation && a.animationName === 'drift') continue;
      p ? a.pause() : a.play();
    }
  }
  pauseBtn.addEventListener('click', () => setPaused(!paused));

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { world.classList.add('instant'); place(ch); void world.offsetWidth; world.classList.remove('instant'); }, 80);
  });

  // ── Download: the button points at this system's package, the menu lists the others, as on index.html ──
  // scripts/site/build.mjs writes the version into the links. A page it has not built still says {{VERSION}}:
  // there the latest release's tag is asked of GitHub, and the version line (the build's news) is left out.
  const pkgs = [...document.querySelectorAll('.dl-menu [data-name]')];
  const RELEASES = 'https://github.com/Callioper/Lumen/releases/latest';
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|Android/.test(ua) ? null : /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac' : /Linux/.test(ua) ? 'linux' : null;
  const mine = os && document.querySelector(`.dl-menu [data-os="${os}"]`);
  const sub = document.querySelector('[data-sub]');
  mine?.classList.add('mine');
  function pointAt(version) {
    if (version) for (const a of pkgs) a.href = a.getAttribute('href').replaceAll('{{VERSION}}', version);
    if (mine) for (const a of document.querySelectorAll('[data-auto]')) a.href = version ? mine.href : RELEASES;
    if (sub) sub.textContent = [mine ? mine.dataset.name : 'Windows · Mac · Linux', version && `v${version}`].filter(Boolean).join(' · ');
  }
  const written = /\/download\/v([^/]+)\//.exec(pkgs[0]?.getAttribute('href') ?? '')?.[1];
  if (written && !written.includes('{')) pointAt(written);
  else {
    document.querySelector('.news')?.remove();
    for (const a of pkgs) { a.dataset.href = a.getAttribute('href'); a.href = RELEASES; }
    pointAt(null);
    fetch('https://api.github.com/repos/Callioper/Lumen/releases/latest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ${r.status}`))))
      .then((r) => {
        const v = /^v(\d[^\s]*)$/.exec(r.tag_name ?? '')?.[1];
        if (!v) return;
        for (const a of pkgs) a.setAttribute('href', a.dataset.href ?? '');
        pointAt(v);
      })
      .catch(() => {}); // the links stay on the release page, which still has every package
  }
  const more = document.querySelector('.dl-more');
  document.addEventListener('click', (e) => { if (more?.open && !more.contains(e.target)) more.open = false; });

  const start = CHAPTERS.findIndex((c) => c.hash === location.hash.slice(1));
  ch = start > 0 ? start : 0;
  copies.forEach((c, i) => c.classList.toggle('on', i === ch));
  // Fonts change the copy's height, and with it the room the scene gets.
  show(ch, { instant: true });
  document.fonts?.ready.then(() => { world.classList.add('instant'); place(ch); void world.offsetWidth; world.classList.remove('instant'); });
})();
