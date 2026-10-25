// Where the demo leads out: the repository, the downloads, and the home page the demo sits under
// (the site's root; the demo is its demo/ folder). Links marked data-demo-out are let through by the
// demo's link guard (mock.ts), which keeps every other outside link from opening.
export { REPO, DOWNLOADS } from '../links.ts';
export const HOME = new URL('../', new URL(import.meta.env.BASE_URL, location.href)).href;
