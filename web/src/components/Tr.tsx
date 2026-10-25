import { prefs, setPrefs, snipTr, type TrView } from '../store.ts';

// A foreign title or comment in 书影音标记, as the reader chose (prefs.marksTr): the original and its
// Chinese (双语, the default), the Chinese alone (the original on hover), or the original. A text
// with no translation yet, or a Chinese one, shows as it is. block: the Chinese goes on its own line.
export function Tr({ text, block = false }: { text: string; block?: boolean }) {
  const zh = snipTr.value[text];
  const mode = prefs.value.marksTr;
  if (!zh || mode === 'original') return <>{text}</>;
  if (mode === 'translation') return <span title={text}>{zh}</span>;
  return block ? <>{text}<span class="tr-zh block">{zh}</span></> : <>{text}<span class="tr-zh">{zh}</span></>;
}

// Paragraphs (a blurb, an author's note), each followed by its Chinese when 双语.
export function TrParas({ lines }: { lines: string[] }) {
  return <>{lines.map((l, i) => <p key={i}><Tr text={l} block /></p>)}</>;
}

const ORDER: TrView[] = ['bilingual', 'translation', 'original'];
const LABEL: Record<TrView, string> = { bilingual: '双语', translation: '译文', original: '原文' };

// The 书影音标记 header's switch between the three.
export function TrSwitch() {
  const mode = prefs.value.marksTr;
  return (
    <div class="seg tr-switch" role="group" aria-label="外文显示">
      {ORDER.map((m) => <button key={m} class={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setPrefs({ marksTr: m })}>{LABEL[m]}</button>)}
    </div>
  );
}
