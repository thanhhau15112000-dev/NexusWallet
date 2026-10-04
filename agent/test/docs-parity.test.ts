import { describe, expect, it } from 'vitest';
import { buildPages } from '../../web/src/components/DocsPanel.js';
import { buildPagesVi } from '../../web/src/components/docsPagesVi.js';
import { en } from '../../web/src/i18n/locales/en.js';
import { vi } from '../../web/src/i18n/locales/vi.js';

type Facts = { tags: Record<string, number>; code: string[]; blocks: string[]; tabs: string[] };

function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object' && 'props' in node) return text((node as { props: { children?: unknown } }).props.children);
  return '';
}

/** Walks an unrendered element tree and records what a translation must not change: structure, code and links. */
function collect(node: unknown, facts: Facts): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, facts));
    return;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === 'string') {
    facts.tags[type] = (facts.tags[type] ?? 0) + 1;
    if (type === 'code') facts.code.push(text(props.children));
  } else {
    if (typeof props.code === 'string') facts.blocks.push(props.code);
    if (typeof props.tab === 'string') facts.tabs.push(props.tab);
    if (Array.isArray(props.items)) {
      for (const item of props.items as Array<{ id: string; body: unknown }>) {
        facts.blocks.push(`tab:${item.id}`);
        collect(item.body, facts);
      }
    }
  }
  collect(props.children, facts);
}

function factsOf(page: { sections: Array<{ id: string; body: unknown }> }) {
  return page.sections.map((section) => {
    const facts: Facts = { tags: {}, code: [], blocks: [], tabs: [] };
    collect(section.body, facts);
    return { id: section.id, ...facts };
  });
}

describe('Docs tab parity between English and Vietnamese', () => {
  const ctx = { openTab: () => {} };
  const enPages = buildPages(ctx, en);
  const viPages = buildPagesVi(ctx, vi);

  it('has the same pages and sections in the same order', () => {
    expect(viPages.map((page) => page.id)).toEqual(enPages.map((page) => page.id));
    for (const [index, enPage] of enPages.entries()) {
      expect(viPages[index]!.sections.map((section) => section.id), enPage.id).toEqual(
        enPage.sections.map((section) => section.id),
      );
    }
  });

  it('keeps the same structure, code snippets and dashboard links in every section', () => {
    for (const [index, enPage] of enPages.entries()) {
      expect(factsOf(viPages[index]!), `page ${enPage.id}`).toEqual(factsOf(enPage));
    }
  });

  it('has no empty titles or summaries, and the Vietnamese page text differs from English', () => {
    for (const [index, enPage] of enPages.entries()) {
      const viPage = viPages[index]!;
      expect(viPage.title.trim().length, enPage.id).toBeGreaterThan(0);
      expect(viPage.summary.trim().length, enPage.id).toBeGreaterThan(0);
      expect(viPage.summary, enPage.id).not.toBe(enPage.summary);
      for (const section of viPage.sections) expect(section.title.trim().length, `${enPage.id}/${section.id}`).toBeGreaterThan(0);
    }
  });
});
