// Where an article has been sorted out: 学术动态, 期刊目录, 新书. A tag opens that page.
import { select } from '../store.ts';
import type { PageOf } from '../api.ts';

const LABEL: Record<PageOf, string> = { notices: '学术动态', tocs: '期刊目录', books: '新书' };

export function PageTags({ pages, lead }: { pages?: PageOf[]; lead?: string }) {
  if (!pages?.length) return null;
  return (
    <span class="page-tags">
      {lead && <span class="page-tags-lead">{lead}</span>}
      {pages.map((p) => (
        <button key={p} class="page-tag" title={`在「${LABEL[p]}」里看`}
          onClick={(e) => { e.stopPropagation(); void select({ kind: p }); }}>{LABEL[p]}</button>
      ))}
    </span>
  );
}
