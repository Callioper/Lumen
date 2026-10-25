import { useState, useEffect } from 'preact/hooks';
import { api, type ProfileStats, type RecProfile, type RecCluster } from '../api.ts';
import { notify } from '../store.ts';
import { ago, cx } from '../util.ts';

const DAY_OPTIONS = [7, 30, 90] as const;

const TYPE_LABEL: Record<string, string> = {
  like: '喜欢', unlike: '取消喜欢', clip: '存档到 Obsidian', star: '收藏', unstar: '取消收藏',
  read_complete: '读完', skim: '略读', skip: '跳过（不到 3 秒）', bounce: '秒退',
  less_topic: '少推这类', less_source: '少推这个源', less_undo: '撤销不感兴趣',
};
const label = (t: string): string => TYPE_LABEL[t] ?? t;
const NEUTRAL = new Set(['skip', 'bounce']);

// 设置 → 阅读画像: what has been recorded so far, before any of it drives the order of a list.
export function ProfileTab() {
  const [days, setDays] = useState<number>(30);
  const [s, setS] = useState<ProfileStats | null>(null);
  const [rec, setRec] = useState<RecProfile | null>(null);
  const loadRec = (): void => { api.recProfile().then(setRec, (e: Error) => notify(e.message, true)); };
  useEffect(loadRec, []);
  useEffect(() => {
    let live = true;
    api.profileStats(days).then((r) => { if (live) setS(r); }, (e: Error) => notify(e.message, true));
    return () => { live = false; };
  }, [days]);
  if (!s) return <div class="tab-body narrow"><span class="spinner" /></div>;
  // The recommender's own count (current likes, stars, archives, reads to the end), not the event tally.
  const ready = rec ? !rec.coldStart : false;
  return (
    <div class="tab-body narrow profile">
      <div class="row-actions">
        <h4 class="grow">近 {s.days} 天</h4>
        {DAY_OPTIONS.map((n) => <button key={n} class={cx('btn small', n === days && 'primary')} onClick={() => setDays(n)}>{n} 天</button>)}
      </div>
      <p class="small">
        记下 <b>{s.signals}</b> 条偏好事件{rec && <>，推荐用到 <b>{rec.signals}</b> 条{ready ? '，已经起步' : `，要攒够 ${rec.needed} 条才起步`}</>}。
        另有 <b>{s.bulkRead}</b> 篇没打开就标了已读（批量、滚过即读），不算偏好。
      </p>
      <p class="small muted">喜欢 <kbd>l</kbd>、不感兴趣 <kbd>x</kbd> / <kbd>X</kbd>、收藏、存档都算明确信号；读完要拉到底且停留够久，否则只算略读。</p>

      {rec && <RecSection rec={rec} reload={loadRec} />}

      <h4>按类型</h4>
      {s.byType.length ? (
        <ul class="stat-list two">
          {s.byType.map((t) => <li key={t.type} class={cx(NEUTRAL.has(t.type) && 'muted')}><span>{label(t.type)}</span><b>{t.n}</b></li>)}
        </ul>
      ) : <p class="small muted">还没有记录。打开几篇文章读一读就有了。</p>}

      {s.feeds.length > 0 && <>
        <h4>来源</h4>
        <ul class="stat-list">
          <li class="head"><span>订阅源</span><span>得分</span><span>打开</span><span>秒退</span></li>
          {s.feeds.map((f) => (
            <li key={f.id}><span class="ellipsis">{f.title}</span><b class={cx(f.score < 0 && 'bad')}>{f.score}</b><span>{f.views}</span><span>{f.bounces}</span></li>
          ))}
        </ul>
      </>}

      {s.recent.length > 0 && <>
        <h4>最近的信号</h4>
        <ul class="stat-list recent">
          {s.recent.map((r, i) => (
            <li key={`${r.entryId}-${i}`}><span class="small muted">{ago(r.at)}</span><span>{label(r.type)}</span><span class="ellipsis" title={r.feed}>{r.title || `#${r.entryId}`}</span></li>
          ))}
        </ul>
      </>}
    </div>
  );
}

// 兴趣簇: what the 推荐 order leans on. Renaming or hiding one changes the next ranking.
function RecSection({ rec, reload }: { rec: RecProfile; reload: () => void }) {
  const pos = rec.clusters.filter((c) => c.polarity === 'pos');
  const neg = rec.clusters.filter((c) => c.polarity === 'neg');
  const pct = (m: { opened: number; completed: number } | undefined): string => (m && m.opened ? `${Math.round((m.completed / m.opened) * 100)}%（${m.completed}/${m.opened}）` : '—');
  const byMode = new Map(rec.compare.map((c) => [c.mode, c]));
  return <>
    <h4>兴趣簇</h4>
    <p class="small muted">按相近程度把有信号的文章归成一簇，越重越靠前；单篇的簇分量轻。名字由 AI 起，可以改；隐藏后不再拿它加分。</p>
    {pos.length ? <ul class="cluster-list">{pos.map((c) => <ClusterRow key={c.anchor} c={c} reload={reload} />)}</ul>
      : <p class="small muted">还没有。</p>}
    {neg.length > 0 && <>
      <h4>少推这类</h4>
      <ul class="cluster-list">{neg.map((c) => <ClusterRow key={c.anchor} c={c} reload={reload} />)}</ul>
    </>}
    <h4>常看的名字</h4>
    <p class="small muted">收藏、喜欢、存档、读完的文章里至少出现两次的人名（取自 Obsidian 人名库）和书名；推荐时提到它们的文章略微靠前。</p>
    {rec.keywords?.length ? <p class="small">{rec.keywords.join('、')}</p> : <p class="small muted">还没有。</p>}
    <h4>推荐 vs 最新</h4>
    <p class="small">从前 10 位打开的文章里读完的比例：推荐 <b>{pct(byMode.get('recommend'))}</b>，最新 <b>{pct(byMode.get('latest'))}</b>。</p>
  </>;
}

function ClusterRow({ c, reload }: { c: RecCluster; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const save = (patch: { name?: string | null; hidden?: boolean }): void => {
    api.updateCluster(c.anchor, patch).then(() => { setEditing(false); reload(); }, (e: Error) => notify(e.message, true));
  };
  return (
    <li class={cx('cluster', c.hidden && 'muted')}>
      <div class="cluster-head">
        {editing
          ? <form onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem('n') as HTMLInputElement).value.trim(); save({ name: v || null }); }}>
              <input name="n" defaultValue={c.name ?? ''} maxLength={20} placeholder="留空交给 AI 起名" autoFocus />
            </form>
          : <b class="grow" onDblClick={() => setEditing(true)}>{c.name ?? '（未命名）'}</b>}
        <span class="small muted">{c.size} 篇 · {c.feeds} 源 · 权重 {c.weight}</span>
        <button class="btn small" onClick={() => setEditing(!editing)}>{editing ? '取消' : '改名'}</button>
        <button class="btn small" onClick={() => save({ hidden: !c.hidden })}>{c.hidden ? '恢复' : '隐藏'}</button>
      </div>
      <ul class="cluster-samples">{c.samples.map((s) => <li key={s.id} class="ellipsis small">{s.title}</li>)}</ul>
    </li>
  );
}
