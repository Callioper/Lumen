// 设置 → 关于: the version, whether a newer one is out (asked of GitHub only on the button), and the
// way to the home page, the release notes, the demo and the source.
import { useState } from 'preact/hooks';
import { api, type UpdateInfo } from '../api.ts';
import { DEMO_SITE, DOWNLOADS, INSTALL, ISSUES, RELEASE_NOTES, REPO, SITE, TOUR } from '../links.ts';

const LINKS: { href: string; label: string; note: string }[] = [
  { href: RELEASE_NOTES, label: '更新日志', note: '每个版本加了什么、改了什么' },
  { href: SITE, label: '主页', note: '介绍与下载' },
  { href: DEMO_SITE, label: '演示站', note: '编出来的数据，可以随便点' },
  { href: TOUR, label: '设计导览', note: '每一页解决什么问题、数据从哪来' },
  { href: INSTALL, label: '安装与可选部分', note: 'AI、RSSHub、Zotero、OCR 怎么配' },
  { href: REPO, label: '源码', note: 'GitHub，MIT 许可' },
  { href: ISSUES, label: '报告问题', note: 'GitHub Issues' },
];

function UpdateCheck() {
  const [state, setState] = useState<'idle' | 'asking' | UpdateInfo>('idle');
  const ask = (): void => {
    setState('asking');
    api.update().then(setState, (e: Error) => setState({ current: __LUMEN_VERSION__, latest: null, newer: false, url: DOWNLOADS, error: e.message }));
  };
  if (import.meta.env.VITE_DEMO) return <p class="small muted">演示站不检查更新；<a href={DOWNLOADS} target="_blank" rel="noreferrer" data-demo-out>最新版本在这里</a>。</p>;
  return (
    <div class="about-update">
      <button type="button" class="btn small" disabled={state === 'asking'} onClick={ask}>{state === 'asking' ? '正在问 GitHub…' : '检查更新'}</button>
      {typeof state === 'object' && (
        state.error ? <span class="small muted">{state.error}</span>
          : state.newer ? <span class="small">有新版本 <b>v{state.latest}</b>：<a href={state.url} target="_blank" rel="noreferrer">下载</a> · <a href={RELEASE_NOTES} target="_blank" rel="noreferrer">看更新了什么</a></span>
            : <span class="small muted">已经是最新版本。</span>
      )}
    </div>
  );
}

export function AboutTab() {
  return (
    <div class="tab-body narrow about">
      <h4>Lumen v{__LUMEN_VERSION__}</h4>
      <p class="small muted">装在自己电脑上的学术向 RSS 阅读器。检查更新时会问一次 GitHub，别的时候不连它。</p>
      <UpdateCheck />
      <h4>链接</h4>
      <ul class="about-links">
        {LINKS.map((l) => (
          <li key={l.href}><a href={l.href} target="_blank" rel="noreferrer" data-demo-out>{l.label}</a><span class="small muted">{l.note}</span></li>
        ))}
      </ul>
    </div>
  );
}
