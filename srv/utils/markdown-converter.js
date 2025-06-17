// srv/utils/markdown-converter.js
/**
 * Einfacher Markdown-zu-HTML Konverter für AI-Antworten
 * Speziell optimiert für SAP UI5 FormattedText Component
 */

class MarkdownConverter {
  
  /**
   * Konvertiert Markdown zu HTML für SAP UI5 FormattedText
   * @param {string} markdown - Markdown Text
   * @returns {string} HTML String
   */
  static convertToHTML(markdown) {
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    let html = markdown;

    // 1. Code-Blöcke (müssen zuerst verarbeitet werden)
    html = this.convertCodeBlocks(html);

    // 2. Inline Code
    html = this.convertInlineCode(html);

    // 3. Headers (H1-H4)
    html = this.convertHeaders(html);

    // 4. Bold und Italic
    html = this.convertTextFormatting(html);

    // 5. Listen
    html = this.convertLists(html);

    // 6. Links (falls vorhanden)
    html = this.convertLinks(html);

    // 7. Emojis und Sonderzeichen beibehalten
    html = this.preserveEmojis(html);

    // 8. Zeilenumbrüche
    html = this.convertLineBreaks(html);

    // 9. SAP UI5 spezifische Optimierungen
    html = this.optimizeForSAPUI5(html);

    return html.trim();
  }

  /**
   * Konvertiert Code-Blöcke
   */
  static convertCodeBlocks(text) {
    // ```language \n code \n ```
    return text.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, language, code) => {
      const cleanCode = this.escapeHTML(code.trim());
      return `<div class="ai-code-block">
        <div class="ai-code-header">${language || 'Code'}</div>
        <pre class="ai-code-content"><code>${cleanCode}</code></pre>
      </div>`;
    });
  }

  /**
   * Konvertiert Inline-Code
   */
  static convertInlineCode(text) {
    return text.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
  }

  /**
   * Konvertiert Headers
   */
  static convertHeaders(text) {
    // ### Header 3
    text = text.replace(/^### (.+)$/gm, '<h3 class="ai-header-3">$1</h3>');
    // ## Header 2  
    text = text.replace(/^## (.+)$/gm, '<h2 class="ai-header-2">$1</h2>');
    // # Header 1
    text = text.replace(/^# (.+)$/gm, '<h1 class="ai-header-1">$1</h1>');
    
    return text;
  }

  /**
   * Konvertiert Bold und Italic
   */
  static convertTextFormatting(text) {
    // **Bold**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong class="ai-bold">$1</strong>');
    // *Italic*
    text = text.replace(/\*([^*]+)\*/g, '<em class="ai-italic">$1</em>');
    
    return text;
  }

  /**
   * Konvertiert Listen
   */
  static convertLists(text) {
    // Unordered Lists
    text = text.replace(/^- (.+)$/gm, '<li class="ai-list-item">$1</li>');
    
    // Wrap consecutive list items in <ul>
    text = text.replace(/(<li class="ai-list-item">.*<\/li>\s*)+/gs, (match) => {
      return `<ul class="ai-unordered-list">${match}</ul>`;
    });

    // Numbered Lists (vereinfacht)
    text = text.replace(/^\d+\. (.+)$/gm, '<li class="ai-numbered-item">$1</li>');
    
    // Wrap consecutive numbered items in <ol>
    text = text.replace(/(<li class="ai-numbered-item">.*<\/li>\s*)+/gs, (match) => {
      return `<ol class="ai-ordered-list">${match}</ol>`;
    });

    return text;
  }

  /**
   * Konvertiert Links
   */
  static convertLinks(text) {
    // [Text](URL)
    return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="#" class="ai-link" data-url="$2" title="$2">$1</a>');
  }

  /**
   * Behält Emojis bei
   */
  static preserveEmojis(text) {
    // Emojis sind bereits Unicode, keine Konvertierung nötig
    return text;
  }

  /**
   * Konvertiert Zeilenumbrüche
   */
  static convertLineBreaks(text) {
    // Doppelte Zeilenumbrüche zu Paragraphen
    text = text.replace(/\n\n+/g, '</p><p class="ai-paragraph">');
    
    // Einzelne Zeilenumbrüche zu <br>
    text = text.replace(/\n/g, '<br/>');
    
    // Wrap in paragraph wenn nicht schon in anderen Tags
    if (!text.startsWith('<') && text.length > 0) {
      text = `<p class="ai-paragraph">${text}</p>`;
    }

    return text;
  }

  /**
   * SAP UI5 spezifische Optimierungen
   */
  static optimizeForSAPUI5(text) {
    // Bereinige leere Paragraphen
    text = text.replace(/<p class="ai-paragraph"><\/p>/g, '');
    
    // Stelle sicher, dass alle Tags geschlossen sind
    text = this.closeOpenTags(text);
    
    return text;
  }

  /**
   * HTML Escaping für Sicherheit
   */
  static escapeHTML(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Schließt offene Tags (vereinfacht)
   */
  static closeOpenTags(html) {
    // Einfache Implementation - für Produktionsumgebung sollte ein richtiger HTML-Parser verwendet werden
    const openTags = [];
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
    
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      if (match[0].startsWith('</')) {
        // Closing tag
        const tag = match[1].toLowerCase();
        const index = openTags.lastIndexOf(tag);
        if (index !== -1) {
          openTags.splice(index, 1);
        }
      } else if (!match[0].endsWith('/>')) {
        // Opening tag (not self-closing)
        openTags.push(match[1].toLowerCase());
      }
    }

    // Schließe offene Tags
    for (let i = openTags.length - 1; i >= 0; i--) {
      html += `</${openTags[i]}>`;
    }

    return html;
  }

  /**
   * Spezielle Konvertierung für SAP-spezifische Inhalte
   */
  static convertSAPContent(text) {
    // SAP UI5 Komponenten-Namen hervorheben
    text = text.replace(/\b(List Report|Object Page|Draft|Value Help|Smart Filter Bar)\b/g, 
      '<span class="ai-sap-term">$1</span>');
    
    // Schritt-für-Schritt Anleitungen
    text = text.replace(/^\*\*Schritt (\d+)\*\*:?/gm, 
      '<div class="ai-step-header">📋 <strong>Schritt $1</strong></div>');
    
    return text;
  }

  /**
   * Hauptmethode für die Konvertierung mit SAP-spezifischen Verbesserungen
   */
  static convertForStammtischAI(markdown) {
    let html = this.convertToHTML(markdown);
    html = this.convertSAPContent(html);
    return html;
  }
}

export default MarkdownConverter;
