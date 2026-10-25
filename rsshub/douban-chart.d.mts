export interface ChartItem { title: string; link: string; guid: string; description: string; pubDate?: string; category: string[]; author: string }
export interface ChartFeed { title: string; link: string; description: string; item: ChartItem[] }
export const CHART_SUBCATS: Record<string, string>;
export const CHART_ROUTE: RegExp;
export function parseChart(html: string, subcat?: string): ChartFeed;
export function doubanBookChart(subcat?: string): Promise<ChartFeed>;
