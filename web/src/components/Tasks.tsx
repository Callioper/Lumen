import { useEffect, useState } from 'preact/hooks';
import { jobs, jobsOpen, clearFinishedJobs } from '../store.ts';
import type { Job } from '../api.ts';
import { Icon } from './Icon.tsx';
import { cx } from '../util.ts';

const KIND_LABEL: Record<Job['kind'], string> = { clip: '存档', ai: 'AI' };
const TICK_MS = 1000;

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const obsidianUrl = (path: string): string => `obsidian://open?path=${encodeURIComponent(path)}`;

// Re-render once a second while something runs, so elapsed times move.
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const running = job.state === 'running';
  return (
    <li class={cx('job', job.state)}>
      <span class="job-state">{running ? <span class="spinner sm" /> : <Icon name={job.state === 'done' ? 'check' : 'x'} />}</span>
      <div class="job-main">
        <div class="job-title"><span class="job-kind">{KIND_LABEL[job.kind]}</span>{job.title}</div>
        <div class="job-step">{job.step} · {duration((job.finishedAt ?? now) - job.startedAt)}</div>
        {job.error && <div class="job-error">{job.error}</div>}
        {job.notePath && !running && job.state === 'done' && <a class="job-link" href={obsidianUrl(job.notePath)}>在 Obsidian 中打开</a>}
      </div>
    </li>
  );
}

export function TasksButton() {
  const running = jobs.value.jobs.filter((j) => j.state === 'running').length;
  return (
    <button class={cx('icon-btn tasks-btn', jobsOpen.value && 'on')} title="任务进度" onClick={() => { jobsOpen.value = !jobsOpen.value; }}>
      {running > 0 ? <span class="spinner sm" /> : <Icon name="tasks" />}
      {running > 0 && <span class="tasks-badge">{running}</span>}
    </button>
  );
}

export function TasksPanel() {
  const { jobs: list, aiQueue, fetching } = jobs.value;
  const running = list.some((j) => j.state === 'running');
  const now = useNow(jobsOpen.value && running);
  if (!jobsOpen.value) return null;
  const finished = list.some((j) => j.state !== 'running');
  return (
    <section class="tasks-panel" aria-label="任务进度">
      <header>
        <h3>任务</h3>
        <span class="grow" />
        {finished && <button class="btn small" onClick={() => void clearFinishedJobs()}>清除已完成</button>}
        <button class="icon-btn sm" title="关闭" onClick={() => { jobsOpen.value = false; }}><Icon name="x" /></button>
      </header>
      <div class="tasks-bg">
        <span>{fetching > 0 ? <><span class="pulse" />正在抓取 {fetching} 个源</> : '订阅抓取空闲'}</span>
        <span>{aiQueue > 0 ? `AI 摘要队列 ${aiQueue} 篇` : 'AI 摘要队列已清空'}</span>
      </div>
      {list.length
        ? <ul class="job-list">{list.map((j) => <JobRow key={j.id} job={j} now={now} />)}</ul>
        : <p class="small muted tasks-empty">还没有任务。按 <kbd>c</kbd> 存档或在阅读页抓取全文后，进度会显示在这里（服务重启后清空）。</p>}
    </section>
  );
}
