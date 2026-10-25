// In-memory record of user-started background work (archiving, AI analysis, full-text fetches)
// so the UI can show what is running and how it ended. Lost on restart by design.
export type JobKind = 'clip' | 'ai';
export type JobState = 'running' | 'done' | 'failed';

export interface Job {
  id: number;
  kind: JobKind;
  entryId: number;
  title: string;
  state: JobState;
  step: string;             // what is happening now, or how it ended
  startedAt: number;        // ms
  finishedAt?: number;
  error?: string;
  notePath?: string;        // absolute path of the Obsidian note, for clip jobs
}

const KEEP_FINISHED = 40;

export class Jobs {
  private jobs: Job[] = [];
  private nextId = 1;
  private events: EventTarget;

  constructor(events: EventTarget) { this.events = events; }

  start(kind: JobKind, entryId: number, title: string, step: string): number {
    const id = this.nextId++;
    this.jobs = [{ id, kind, entryId, title, state: 'running', step, startedAt: Date.now() }, ...this.jobs];
    this.emit();
    return id;
  }

  update(id: number, patch: Partial<Pick<Job, 'step' | 'notePath' | 'title'>>): void {
    this.replace(id, (j) => ({ ...j, ...patch }));
  }

  finish(id: number, state: Exclude<JobState, 'running'>, step: string, error?: string): void {
    this.replace(id, (j) => ({ ...j, state, step, error, finishedAt: Date.now() }));
    const running = this.jobs.filter((j) => j.state === 'running');
    const finished = this.jobs.filter((j) => j.state !== 'running').slice(0, KEEP_FINISHED);
    this.jobs = [...running, ...finished].sort((a, b) => b.id - a.id);
  }

  list(): Job[] { return this.jobs; }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.state === 'running');
    this.emit();
  }

  private replace(id: number, fn: (j: Job) => Job): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? fn(j) : j));
    this.emit();
  }

  private emit(): void { this.events.dispatchEvent(new Event('jobs')); }
}
