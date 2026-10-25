import { app, settingsOpen } from '../store.ts';

// An empty page that only the AI can fill says so, instead of waiting for something that never comes.
export function NeedsAi({ what }: { what: string }) {
  if (!app.value || (app.value.settings.ai.enabled && app.value.hasAiKey)) return null;
  return (
    <p class="muted empty needs-ai">
      {what}要先配一个模型接口。{' '}
      <button class="link" onClick={() => { settingsOpen.value = 'ai'; }}>去设置 AI</button>
    </p>
  );
}
