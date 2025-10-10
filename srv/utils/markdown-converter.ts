// srv/utils/markdown-converter.ts
/**
 * Markdown-zu-HTML Konverter für AI-Antworten
 * Nutzt markdown-it und veredelt das Ergebnis für das ClaimAI UI.
 */

import MarkdownIt from 'markdown-it';

type Renderer = InstanceType<typeof MarkdownIt>['renderer'];
type RenderTokenParams = Parameters<Renderer['renderToken']>;
type TokenArray = RenderTokenParams[0];
type Token = TokenArray extends Array<infer T> ? T : never;
type MarkdownItOptions = RenderTokenParams[2];
type RenderRule = (tokens: TokenArray, idx: number, options: MarkdownItOptions, env: unknown, self: Renderer) => string;

class MarkdownConverter {
  private static readonly markdown = MarkdownConverter.createMarkdownIt();

  static convertToHTML(markdown: string): string {
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    const html = this.markdown.render(markdown);
    return html.trim();
  }

  static convertForClaims(markdown: string): string {
    const html = this.convertToHTML(markdown);
    return this.convertSAPContent(html);
  }

  private static createMarkdownIt(): MarkdownIt {
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      typographer: true,
    });

    const { escapeHtml } = md.utils;

    const defaultRender: RenderRule = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      _env: unknown,
      self: Renderer,
    ): string => self.renderToken(tokens, idx, options);

    const headingOpen = md.renderer.rules.heading_open ?? defaultRender;
    md.renderer.rules.heading_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      const token = tokens[idx];
      switch (token.tag) {
        case 'h1':
          token.attrJoin('class', 'ai-header-1');
          break;
        case 'h2':
          token.attrJoin('class', 'ai-header-2');
          break;
        case 'h3':
          token.attrJoin('class', 'ai-header-3');
          break;
        default:
          token.attrJoin('class', 'ai-header');
          break;
      }
      return headingOpen(tokens, idx, options, env, self);
    };

    const paragraphOpen = md.renderer.rules.paragraph_open ?? defaultRender;
    md.renderer.rules.paragraph_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      tokens[idx].attrJoin('class', 'ai-paragraph');
      return paragraphOpen(tokens, idx, options, env, self);
    };

    const bulletListOpen = md.renderer.rules.bullet_list_open ?? defaultRender;
    md.renderer.rules.bullet_list_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      tokens[idx].attrJoin('class', 'ai-unordered-list');
      return bulletListOpen(tokens, idx, options, env, self);
    };

    const orderedListOpen = md.renderer.rules.ordered_list_open ?? defaultRender;
    md.renderer.rules.ordered_list_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      tokens[idx].attrJoin('class', 'ai-ordered-list');
      return orderedListOpen(tokens, idx, options, env, self);
    };

    const listItemOpen = md.renderer.rules.list_item_open ?? defaultRender;
    md.renderer.rules.list_item_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      const token = tokens[idx];
      const markup = token.markup || '';
      if (markup.startsWith('1') || markup === '1.') {
        token.attrJoin('class', 'ai-numbered-item');
      } else {
        token.attrJoin('class', 'ai-list-item');
      }
      return listItemOpen(tokens, idx, options, env, self);
    };

    const linkOpen = md.renderer.rules.link_open ?? defaultRender;
    md.renderer.rules.link_open = (
      tokens: Token[],
      idx: number,
      options: MarkdownItOptions,
      env: unknown,
      self: Renderer,
    ): string => {
      const token = tokens[idx];
      const href = token.attrGet('href');
      if (href) {
        token.attrSet('data-url', href);
        token.attrSet('title', href);
        token.attrSet('href', '#');
      }
      token.attrSet('rel', 'noopener noreferrer');
      token.attrSet('target', '_blank');
      token.attrJoin('class', 'ai-link');
      return linkOpen(tokens, idx, options, env, self);
    };

    md.renderer.rules.code_inline = (tokens: Token[], idx: number): string => {
      const token = tokens[idx];
      return `<code class="ai-inline-code">${escapeHtml(token.content)}</code>`;
    };

    md.renderer.rules.code_block = (tokens: Token[], idx: number): string => {
      const token = tokens[idx];
      const cleanCode = escapeHtml(token.content);
      return `<div class="ai-code-block">
  <div class="ai-code-header">Code</div>
  <pre class="ai-code-content"><code>${cleanCode}</code></pre>
</div>`;
    };

    md.renderer.rules.fence = (tokens: Token[], idx: number): string => {
      const token = tokens[idx];
      const info = token.info ? token.info.trim().split(/\s+/)[0] : '';
      const language = info ? escapeHtml(info) : 'Code';
      const cleanCode = escapeHtml(token.content);
      return `<div class="ai-code-block">
  <div class="ai-code-header">${language}</div>
  <pre class="ai-code-content"><code>${cleanCode}</code></pre>
</div>`;
    };

    return md;
  }

  private static convertSAPContent(html: string): string {
    if (!html) return '';

    let enriched = html.replace(
      /\b(List Report|Object Page|Draft|Value Help|Smart Filter Bar)\b/g,
      '<span class="ai-sap-term">$1</span>',
    );

    enriched = enriched.replace(
      /<p>\s*<strong>Schritt (\d+)<\/strong>\s*:?\s*([\s\S]*?)<\/p>/gi,
      (_match, step: string, rest: string) => {
        const body = rest.trim();
        const content = body.length > 0 ? `<p class="ai-paragraph">${body}</p>` : '';
        return `<div class="ai-step-header">📋 <strong>Schritt ${step}</strong></div>${content}`;
      },
    );

    return enriched;
  }
}

export default MarkdownConverter;
