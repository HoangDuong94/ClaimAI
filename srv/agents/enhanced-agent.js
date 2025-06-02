// srv/agents/enhanced-agent.js
/**
 * Enhanced AI Agent System basierend auf Anthropic's "Building Effective Agents"
 * Implementiert: Routing, Prompt Chaining, Orchestrator-Workers, Evaluator-Optimizer
 */

const DatabaseTools = require('../tools/database-tools');
const MarkdownConverter = require('../utils/markdown-converter');

class EnhancedAIAgent {
  
  constructor() {
    this.dbTools = new DatabaseTools();
    this.executionHistory = [];
    this.currentPlan = null;
  }

  /**
   * ROUTING PATTERN: Intelligente Klassifikation der Benutzeranfrage
   */
  async classifyRequest(prompt) {
    console.log('=== ROUTING: Request Classification ===');
    
    const classificationPrompt = `Du bist ein Experte für die StammtischAI-Anwendung und klassifizierst Benutzeranfragen.

VERFÜGBARE DATABASE TOOLS:
1. "get_stammtische" - Alle Stammtische abrufen (mit limit/offset)
2. "get_stammtisch_by_id" - Einzelnen Stammtisch mit Details abrufen (braucht ID)
3. "search_stammtische" - Nach Stammtischen suchen (braucht Suchbegriff)
4. "get_praesentatoren" - Alle Präsentatoren abrufen
5. "get_teilnehmer" - Teilnehmer für einen Stammtisch abrufen (braucht stammtischId)
6. "get_stammtisch_statistics" - Umfassende Statistiken über alle Daten
7. "get_upcoming_stammtische" - Kommende Stammtische abrufen

KLASSIFIKATIONS-KATEGORIEN:

**personal_chat** - Persönliche/allgemeine Fragen - KEINE Tools nötig
- Keywords: "wie heißt", "wer bist", "hallo", "hi", "danke", "guten tag", "wie geht"
- Beispiele:
  * "Wie heißt du?" → Persönliche Vorstellung
  * "Wer bist du?" → Agent-Identität erklären
  * "Hallo" → Begrüßung
  * "Danke" → Höflichkeitsantwort

**help_task** - Hilfe zur Anwendung - KEINE Tools nötig
- Keywords: "hilfe", "help", "wie funktioniert", "anleitung", "was kann", "wie bediene"
- Beispiele:
  * "Wie funktioniert die Anwendung?"
  * "Was kannst du alles?"
  * "Hilfe bei der Navigation"

**simple_query** - Braucht GENAU EIN Tool für StammtischAI-Daten
- Keywords: "zeige", "liste", "alle", "wie viele", "statistik", "anzahl", "kommend", "nächst", "präsentator"
- Beispiele: 
  * "Zeige mir alle Stammtische" → get_stammtische
  * "Wie viele Events haben wir?" → get_stammtisch_statistics  
  * "Welche Präsentatoren gibt es?" → get_praesentatoren
  * "Kommende Stammtische?" → get_upcoming_stammtische

**search_task** - Spezifisch für Suche in StammtischAI-Daten
- Keywords: "suche", "finde", "search", "wo", "welche" + Suchbegriff
- Beispiele:
  * "Suche nach CAP-Workshops" → search_stammtische
  * "Finde Online-Events" → search_stammtische
  * "Wo sind die JavaScript Stammtische?" → search_stammtische

**statistical_task** - Braucht Statistiken + Analyse/Berechnung
- Keywords: "statistik", "analyse", "auswertung", "trends", "vergleich", "performance"
- Beispiele:
  * "Analysiere unsere Event-Performance" → get_stammtisch_statistics + Analyse
  * "Zeige mir Trends der letzten Monate" → get_stammtisch_statistics + get_stammtische
  * "Welche Orte sind am beliebtesten?" → get_stammtisch_statistics + Auswertung

**complex_analysis** - Braucht MEHRERE Tools + Orchestration
- Kombination verschiedener Datenquellen
- Beispiele:
  * "Erstelle einen Bericht über Stammtische und deren Teilnehmer" → get_stammtische + get_teilnehmer + get_praesentatoren
  * "Analysiere alle Daten und gib Empfehlungen" → mehrere Tools + Orchestration
  * "Vergleiche vergangene und kommende Events" → get_stammtische + get_upcoming_stammtische + Analyse

WICHTIG: Wenn die Frage NICHTS mit StammtischAI-Daten zu tun hat, wähle "personal_chat" oder "help_task"!

BENUTZERANFRAGE: "${prompt}"

Analysiere die Anfrage und klassifiziere sie:

<classification>
{
  "category": "kategorie_name",
  "confidence": 0.9,
  "reasoning": "Detaillierte Begründung: Welche Keywords erkannt, warum KEINE Tools bei personal_chat/help_task",
  "suggested_tools": ["tool1", "tool2"],
  "parameters": {"key": "value"},
  "complexity_level": "low/medium/high"
}
</classification>`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4.1" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: classificationPrompt },
        params: { max_tokens_to_sample: 600, temperature: 0.1 }
      });

      const classificationText = response.getContent();
      const match = classificationText.match(/<classification>([\s\S]*?)<\/classification>/);
      
      if (match) {
        const classification = JSON.parse(match[1].trim());
        console.log('Classification Result:', classification);
        
        // Validiere die Klassifikation
        return this.validateClassification(classification, prompt);
      }
    } catch (error) {
      console.error('Classification failed:', error);
    }

    // Fallback zu verbesserter Klassifikation
    return this.enhancedFallbackClassification(prompt);
  }

  /**
   * Validiert und korrigiert die AI-Klassifikation falls nötig
   */
  validateClassification(classification, prompt) {
    const validCategories = ['personal_chat', 'help_task', 'simple_query', 'search_task', 'statistical_task', 'complex_analysis'];
    
    // Prüfe ob Kategorie gültig ist
    if (!validCategories.includes(classification.category)) {
      console.warn('Invalid category detected, using fallback');
      return this.enhancedFallbackClassification(prompt);
    }

    // Prüfe Konsistenz: personal_chat und help_task sollten KEINE Tools haben
    if ((classification.category === 'personal_chat' || classification.category === 'help_task') && 
        classification.suggested_tools?.length > 0) {
      console.log('Correcting personal_chat/help_task to have no tools');
      classification.suggested_tools = [];
      classification.parameters = {};
    }

    // Prüfe Konsistenz: simple_query sollte nur 1 Tool vorschlagen
    if (classification.category === 'simple_query' && classification.suggested_tools?.length > 1) {
      console.log('Correcting simple_query to use only first tool');
      classification.suggested_tools = [classification.suggested_tools[0]];
    }

    // Prüfe ob search_task auch wirklich search_stammtische verwendet
    if (classification.category === 'search_task' && 
        !classification.suggested_tools?.includes('search_stammtische')) {
      console.log('Correcting search_task to use search_stammtische');
      classification.suggested_tools = ['search_stammtische'];
    }

    return classification;
  }

  /**
   * Verbesserte Fallback-Klassifikation mit Tool-Integration
   */
  enhancedFallbackClassification(prompt) {
    const lower = prompt.toLowerCase();
    
    // Personal/Chat Pattern (höchste Priorität für persönliche Fragen)
    if (lower.includes('wie heißt') || lower.includes('wer bist') || lower.includes('hallo') || 
        lower.includes('hi') || lower.includes('danke') || lower.includes('guten tag') ||
        lower.includes('wie geht') || lower.match(/^(hallo|hi|hey|moin|servus)$/)) {
      return {
        category: 'personal_chat',
        confidence: 0.95,
        reasoning: 'Persönliche/Begrüßungs-Keywords erkannt - keine Tools nötig',
        suggested_tools: [],
        parameters: {},
        complexity_level: 'low'
      };
    }

    // Hilfe-Pattern
    if (lower.includes('hilfe') || lower.includes('help') || lower.includes('wie funktioniert') || 
        lower.includes('was kannst') || lower.includes('anleitung')) {
      return {
        category: 'help_task',
        confidence: 0.9,
        reasoning: 'Hilfe-Keywords erkannt - keine Tools nötig',
        suggested_tools: [],
        parameters: {},
        complexity_level: 'low'
      };
    }

    // Suche-Pattern
    if (lower.includes('suche') || lower.includes('finde') || lower.includes('search')) {
      const searchQuery = this.extractSearchQuery(prompt);
      return {
        category: 'search_task',
        confidence: 0.8,
        reasoning: 'Suchbegriff erkannt',
        suggested_tools: ['search_stammtische'],
        parameters: searchQuery ? { query: searchQuery } : {},
        complexity_level: 'low'
      };
    }

    // Statistik/Analyse-Pattern
    if (lower.includes('statistik') || lower.includes('analyse') || lower.includes('trends') || 
        lower.includes('auswertung') || lower.includes('performance') || lower.includes('vergleich')) {
      
      // Prüfe ob es komplex ist (mehrere Datenquellen)
      const isComplex = (lower.includes('bericht') || lower.includes('empfehlung') || 
                        lower.includes('vergleiche') || lower.includes('alle daten'));
      
      return {
        category: isComplex ? 'complex_analysis' : 'statistical_task',
        confidence: 0.7,
        reasoning: isComplex ? 'Komplexe Analyse mit mehreren Datenquellen' : 'Statistische Auswertung',
        suggested_tools: isComplex ? ['get_stammtisch_statistics', 'get_stammtische'] : ['get_stammtisch_statistics'],
        parameters: {},
        complexity_level: isComplex ? 'high' : 'medium'
      };
    }

    // Prüfe ob es überhaupt StammtischAI-relevante Keywords gibt
    const stammtischKeywords = ['stammtisch', 'event', 'events', 'präsentator', 'teilnehmer', 
                               'workshop', 'veranstaltung', 'zeige', 'liste', 'alle'];
    
    const hasStammtischKeywords = stammtischKeywords.some(keyword => lower.includes(keyword));
    
    if (!hasStammtischKeywords) {
      // Wenn keine StammtischAI-Keywords gefunden → personal_chat
      return {
        category: 'personal_chat',
        confidence: 0.8,
        reasoning: 'Keine StammtischAI-relevanten Keywords gefunden - allgemeine Frage',
        suggested_tools: [],
        parameters: {},
        complexity_level: 'low'
      };
    }

    // Simple Query Pattern (nur wenn StammtischAI-Keywords vorhanden)
    const identifiedTool = this.identifyTool(prompt);
    const parameters = this.extractParameters(prompt, identifiedTool);
    
    return {
      category: 'simple_query',
      confidence: 0.6,
      reasoning: `StammtischAI-Tool identifiziert: ${identifiedTool}`,
      suggested_tools: [identifiedTool],
      parameters,
      complexity_level: 'low'
    };
  }

  /**
   * ORCHESTRATOR-WORKERS PATTERN: Komplexe Tasks in Subtasks aufteilen
   */
  async orchestrateComplexTask(prompt) {
    console.log('=== ORCHESTRATOR: Planning Complex Task ===');
    
    const planningPrompt = `Du bist ein Task-Orchestrator für die StammtischAI Anwendung.
Analysiere diese komplexe Anfrage und teile sie in konkrete Subtasks auf:

VERFÜGBARE TOOLS:
- get_stammtische: Alle Stammtische abrufen
- search_stammtische: Nach Stammtischen suchen  
- get_stammtisch_statistics: Statistiken generieren
- get_praesentatoren: Präsentatoren-Liste
- get_upcoming_stammtische: Kommende Events

ANFRAGE: ${prompt}

Erstelle einen Ausführungsplan:

<analysis>
Analyse der Anfrage und benötigte Schritte
</analysis>

<plan>
[
  {
    "step": 1,
    "action": "tool_name",
    "parameters": {"param": "value"},
    "purpose": "Warum dieser Schritt nötig ist"
  },
  {
    "step": 2, 
    "action": "analyze_results",
    "purpose": "Ergebnisse auswerten"
  }
]
</plan>`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: planningPrompt },
        params: { max_tokens_to_sample: 1000, temperature: 0.2 }
      });

      const content = response.getContent();
      const analysisMatch = content.match(/<analysis>([\s\S]*?)<\/analysis>/);
      const planMatch = content.match(/<plan>([\s\S]*?)<\/plan>/);

      if (analysisMatch && planMatch) {
        const analysis = analysisMatch[1].trim();
        const plan = JSON.parse(planMatch[1].trim());
        
        console.log('Analysis:', analysis);
        console.log('Execution Plan:', plan);
        
        this.currentPlan = { analysis, steps: plan };
        return await this.executePlan(plan);
      }
    } catch (error) {
      console.error('Orchestration failed:', error);
    }

    return null;
  }

  /**
   * Plan-Execution mit Workers
   */
  async executePlan(steps) {
    console.log('=== WORKERS: Executing Plan Steps ===');
    
    const results = [];
    
    for (const step of steps) {
      console.log(`Executing Step ${step.step}: ${step.purpose}`);
      
      if (step.action && step.action !== 'analyze_results') {
        try {
          const toolResult = await this.dbTools.executeTool(step.action, step.parameters || {});
          results.push({
            step: step.step,
            action: step.action,
            result: toolResult,
            purpose: step.purpose
          });
          console.log(`Step ${step.step} completed successfully`);
        } catch (error) {
          console.error(`Step ${step.step} failed:`, error);
          results.push({
            step: step.step,
            action: step.action,
            error: error.message,
            purpose: step.purpose
          });
        }
      }
    }
    
    return results;
  }

  /**
   * PROMPT CHAINING PATTERN: Schrittweise Verarbeitung
   */
  async chainedProcessing(prompt, toolResults) {
    console.log('=== PROMPT CHAINING: Sequential Processing ===');
    
    const steps = [
      {
        name: 'data_analysis',
        prompt: `Analysiere die Daten aus den Tool-Ergebnissen und identifiziere die wichtigsten Erkenntnisse:

TOOL-ERGEBNISSE:
${JSON.stringify(toolResults, null, 2)}

BENUTZERANFRAGE: ${prompt}

Gib eine strukturierte Analyse zurück:
<insights>
Die wichtigsten Erkenntnisse aus den Daten
</insights>`
      },
      {
        name: 'response_generation', 
        prompt: `Basierend auf den Insights, erstelle eine benutzerfreundliche Antwort:

ERKENNTNISSE: {previous_result}

BENUTZERANFRAGE: ${prompt}

Erstelle eine Markdown-formatierte Antwort:
<response>
Benutzerfreundliche Antwort mit Markdown-Formatierung
</response>`
      }
    ];

    let previousResult = '';
    
    for (const step of steps) {
      const stepPrompt = step.prompt.replace('{previous_result}', previousResult);
      
      try {
        const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
        const client = new OrchestrationClient({
          llm: { model_name: "gpt-4" },
          templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
        });

        const response = await client.chatCompletion({
          inputParams: { user_prompt: stepPrompt },
          params: { max_tokens_to_sample: 2000, temperature: 0.3 }
        });

        const content = response.getContent();
        
        if (step.name === 'data_analysis') {
          const insightsMatch = content.match(/<insights>([\s\S]*?)<\/insights>/);
          previousResult = insightsMatch ? insightsMatch[1].trim() : content;
        } else if (step.name === 'response_generation') {
          const responseMatch = content.match(/<response>([\s\S]*?)<\/response>/);
          return responseMatch ? responseMatch[1].trim() : content;
        }

        console.log(`Chain Step ${step.name} completed`);
        
      } catch (error) {
        console.error(`Chain step ${step.name} failed:`, error);
        return `Fehler bei der Verarbeitung: ${error.message}`;
      }
    }

    return previousResult;
  }

  /**
   * EVALUATOR-OPTIMIZER PATTERN: Selbst-Evaluation und Verbesserung
   */
  async evaluateAndOptimize(response, originalPrompt, toolResults) {
    console.log('=== EVALUATOR-OPTIMIZER: Self-Evaluation ===');
    
    const evaluationPrompt = `Evaluiere diese AI-Antwort auf Qualität, Vollständigkeit und Benutzerfreundlichkeit:

ORIGINAL-ANFRAGE: ${originalPrompt}

VERFÜGBARE DATEN: ${JSON.stringify(toolResults?.slice(0, 2), null, 2)}

GENERIERTE ANTWORT: ${response}

Bewerte die Antwort:
<evaluation>
{
  "quality_score": 0.8,
  "completeness_score": 0.9, 
  "user_friendliness_score": 0.7,
  "needs_improvement": true/false,
  "specific_issues": ["Liste der Probleme"],
  "suggestions": ["Verbesserungsvorschläge"]
}
</evaluation>`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const evalResponse = await client.chatCompletion({
        inputParams: { user_prompt: evaluationPrompt },
        params: { max_tokens_to_sample: 800, temperature: 0.1 }
      });

      const evalContent = evalResponse.getContent();
      const evalMatch = evalContent.match(/<evaluation>([\s\S]*?)<\/evaluation>/);
      
      if (evalMatch) {
        const evaluation = JSON.parse(evalMatch[1].trim());
        console.log('Evaluation Result:', evaluation);
        
        // Wenn Verbesserung nötig, optimiere die Antwort
        if (evaluation.needs_improvement) {
          return await this.optimizeResponse(response, evaluation, originalPrompt);
        }
      }
    } catch (error) {
      console.error('Evaluation failed:', error);
    }

    return response; // Rückgabe der ursprünglichen Antwort falls Evaluation fehlschlägt
  }

  /**
   * Response-Optimierung basierend auf Evaluation
   */
  async optimizeResponse(originalResponse, evaluation, originalPrompt) {
    console.log('=== OPTIMIZER: Improving Response ===');
    
    const optimizationPrompt = `Verbessere diese AI-Antwort basierend auf der Evaluation:

ORIGINAL-ANTWORT: ${originalResponse}

EVALUATION: ${JSON.stringify(evaluation, null, 2)}

BENUTZERANFRAGE: ${originalPrompt}

Erstelle eine verbesserte Version, die die identifizierten Probleme behebt:
<improved_response>
Verbesserte Antwort hier
</improved_response>`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: optimizationPrompt },
        params: { max_tokens_to_sample: 2500 }
      });

      const content = response.getContent();
      const improvedMatch = content.match(/<improved_response>([\s\S]*?)<\/improved_response>/);
      
      if (improvedMatch) {
        console.log('Response successfully optimized');
        return improvedMatch[1].trim();
      }
    } catch (error) {
      console.error('Optimization failed:', error);
    }

    return originalResponse;
  }

  /**
   * MAIN AGENT PROCESSING: Koordiniert alle Patterns
   */
  async processRequest(prompt) {
    console.log('=== ENHANCED AI AGENT: Processing Request ===');
    
    try {
      // Step 1: ROUTING - Klassifiziere die Anfrage
      const classification = await this.classifyRequest(prompt);
      
      let toolResults = [];
      let response = '';

      // Step 2: Wähle das passende Pattern basierend auf Klassifikation
      switch (classification.category) {
        case 'personal_chat':
          // Persönliche Fragen ohne Tools
          response = await this.generatePersonalResponse(prompt);
          break;
          
        case 'simple_query':
          // Einfache Tool-Ausführung
          toolResults = await this.handleSimpleQuery(prompt);
          response = await this.generateSimpleResponse(prompt, toolResults);
          break;
          
        case 'complex_analysis':
          // ORCHESTRATOR-WORKERS Pattern
          toolResults = await this.orchestrateComplexTask(prompt);
          response = await this.chainedProcessing(prompt, toolResults);
          break;
          
        case 'search_task':
          // Optimierte Such-Pipeline
          toolResults = await this.handleSearchTask(prompt);
          response = await this.generateSearchResponse(prompt, toolResults);
          break;
          
        case 'statistical_task':
          // Statistik-Pipeline
          toolResults = await this.handleStatisticalTask(prompt);
          response = await this.chainedProcessing(prompt, toolResults);
          break;
          
        case 'help_task':
          // Direkte Hilfe ohne Tools
          response = await this.generateHelpResponse(prompt);
          break;
          
        default:
          // Fallback zu Standard-Verarbeitung
          toolResults = await this.handleSimpleQuery(prompt);
          response = await this.generateSimpleResponse(prompt, toolResults);
      }

      // Step 3: EVALUATOR-OPTIMIZER - Verbessere die Antwort
      if (toolResults.length > 0) {
        response = await this.evaluateAndOptimize(response, prompt, toolResults);
      }

      // Step 4: Konvertiere zu HTML für bessere Darstellung
      const htmlResponse = MarkdownConverter.convertForStammtischAI(response);

      // Step 5: Protokolliere die Execution
      this.logExecution({
        prompt,
        classification,
        toolsUsed: toolResults.length,
        pattern: this.getPatternUsed(classification.category),
        success: true
      });

      return htmlResponse;

    } catch (error) {
      console.error('Enhanced Agent processing failed:', error);
      
      this.logExecution({
        prompt,
        classification: { category: 'error' },
        error: error.message,
        success: false
      });

      return this.generateErrorResponse(error);
    }
  }

  /**
   * Pattern-spezifische Handler
   */
  async handleSimpleQuery(prompt) {
    const toolName = this.identifyTool(prompt);
    const parameters = this.extractParameters(prompt, toolName);
    
    if (toolName) {
      const result = await this.dbTools.executeTool(toolName, parameters);
      return [result];
    }
    return [];
  }

  async handleSearchTask(prompt) {
    const searchQuery = this.extractSearchQuery(prompt);
    if (searchQuery) {
      const result = await this.dbTools.executeTool('search_stammtische', { query: searchQuery });
      return [result];
    }
    return [];
  }

  async handleStatisticalTask(prompt) {
    const result = await this.dbTools.executeTool('get_stammtisch_statistics', {});
    return [result];
  }

  /**
   * Response-Generatoren
   */
  async generatePersonalResponse(prompt) {
    const lower = prompt.toLowerCase();
    
    if (lower.includes('wie heißt') || lower.includes('wer bist')) {
      return `## 👋 Hallo! Ich bin Ihr StammtischAI Assistant

Ich bin ein intelligenter AI-Agent, der Ihnen bei der **StammtischAI-Anwendung** hilft.

**Was ich kann:**
- 📊 **Daten abrufen** aus Ihrer Stammtisch-Datenbank
- 🔍 **Suchen** - nach Events, Präsentatoren, Themen  
- 📈 **Statistiken** - Live-Auswertungen und Trends
- 🤖 **Intelligente Analyse** - komplexe Fragen beantworten

**Probieren Sie zum Beispiel:**
- "Wie viele Stammtische haben wir?"
- "Suche nach CAP-Workshops"
- "Zeige mir kommende Events"

Wie kann ich Ihnen heute helfen?`;
    }
    
    if (lower.includes('hallo') || lower.includes('hi') || lower.includes('guten tag')) {
      return `## 👋 Hallo und willkommen bei StammtischAI!

Schön, dass Sie da sind! Ich bin Ihr AI-Assistant und helfe Ihnen gerne bei allen Fragen rund um Ihre Stammtisch-Events.

**Womit kann ich Ihnen helfen?**
- Events und Teilnehmer verwalten
- Statistiken und Auswertungen
- Suche nach bestimmten Veranstaltungen
- Allgemeine Fragen zur Anwendung

Stellen Sie einfach Ihre Frage! 😊`;
    }
    
    if (lower.includes('danke')) {
      return `## 😊 Gern geschehen!

Es freut mich, dass ich Ihnen helfen konnte. Falls Sie weitere Fragen zu Ihren Stammtisch-Events haben, bin ich jederzeit für Sie da!

**Noch Fragen?** Fragen Sie einfach nach Statistiken, suchen Sie nach Events oder lassen Sie sich die kommenden Veranstaltungen anzeigen.`;
    }
    
    if (lower.includes('wie geht')) {
      return `## 🤖 Mir geht es bestens, danke der Nachfrage!

Als AI-Agent bin ich rund um die Uhr bereit, Ihnen bei der **StammtischAI-Anwendung** zu helfen.

**Aktueller Status:**
- ✅ Datenbankverbindung aktiv
- ✅ Alle Tools funktionsfähig  
- ✅ Bereit für Ihre Anfragen

Wie kann ich Ihnen mit Ihren Stammtisch-Daten helfen?`;
    }
    
    // Standard persönliche Antwort
    return `## 🤖 StammtischAI Assistant

Ich bin Ihr persönlicher AI-Agent für die StammtischAI-Anwendung. 

**Meine Aufgabe:** Ihnen bei der Verwaltung und Analyse Ihrer Stammtisch-Events zu helfen.

**Was möchten Sie wissen?**
- Informationen über Events und Teilnehmer
- Statistiken und Trends  
- Suche nach bestimmten Veranstaltungen
- Hilfe zur Anwendung

Stellen Sie mir einfach eine Frage! 😊`;
  }

  async generateSimpleResponse(prompt, toolResults) {
    if (!toolResults.length) return "Keine Daten gefunden.";
    
    const data = toolResults[0].success ? toolResults[0].data : null;
    if (!data) return "Fehler beim Abrufen der Daten.";
    
    return `Basierend auf den aktuellen Daten: ${JSON.stringify(data, null, 2)}`;
  }

  async generateSearchResponse(prompt, toolResults) {
    if (!toolResults.length || !toolResults[0].success) {
      return "Keine Suchergebnisse gefunden.";
    }
    
    const searchData = toolResults[0].data;
    return `🔍 **Suchergebnisse:**\n\nGefunden: ${searchData.count} Ergebnisse\n\n${JSON.stringify(searchData.results, null, 2)}`;
  }

  async generateHelpResponse(prompt) {
    return `## 🤖 StammtischAI Hilfe

Ich kann Ihnen bei folgenden Aufgaben helfen:

- **Stammtische anzeigen**: "Zeige mir alle Stammtische"
- **Suchen**: "Suche nach CAP-Workshops"  
- **Statistiken**: "Wie viele Events haben wir?"
- **Kommende Events**: "Welche Stammtische sind geplant?"

Wie kann ich Ihnen weiterhelfen?`;
  }

  generateErrorResponse(error) {
    return `❌ **Fehler bei der Verarbeitung**

Es tut mir leid, aber bei der Bearbeitung Ihrer Anfrage ist ein Fehler aufgetreten.

**Was Sie versuchen können:**
- Formulieren Sie Ihre Frage anders
- Versuchen Sie es in einem Moment erneut
- Kontaktieren Sie den Administrator bei anhaltenden Problemen

**Fehlermeldung**: ${error.message}`;
  }

  /**
   * Hilfsmethoden
   */
  identifyTool(prompt) {
    const lower = prompt.toLowerCase();
    if (lower.includes('statistik') || lower.includes('anzahl')) return 'get_stammtisch_statistics';
    if (lower.includes('suche') || lower.includes('finde')) return 'search_stammtische';
    if (lower.includes('kommend') || lower.includes('nächst')) return 'get_upcoming_stammtische';
    if (lower.includes('präsentator')) return 'get_praesentatoren';
    return 'get_stammtische';
  }

  extractParameters(prompt, toolName) {
    if (toolName === 'search_stammtische') {
      const match = prompt.match(/(?:suche|finde).*?(?:nach|for)\s+["']?([^"']+)["']?/i);
      return match ? { query: match[1] } : {};
    }
    return {};
  }

  extractSearchQuery(prompt) {
    const patterns = [
      /(?:suche|finde).*?(?:nach|for)\s+["']?([^"']+)["']?/i,
      /"([^"]+)"/,
      /'([^']+)'/
    ];
    
    for (const pattern of patterns) {
      const match = prompt.match(pattern);
      if (match) return match[1];
    }
    
    return null;
  }

  getPatternUsed(category) {
    const patterns = {
      'simple_query': 'Direct Tool Call',
      'complex_analysis': 'Orchestrator-Workers',
      'search_task': 'Optimized Search',
      'statistical_task': 'Prompt Chaining',
      'help_task': 'Direct Response'
    };
    return patterns[category] || 'Unknown';
  }

  logExecution(details) {
    this.executionHistory.push({
      ...details,
      timestamp: new Date().toISOString()
    });
    
    // Keep last 50 executions
    if (this.executionHistory.length > 50) {
      this.executionHistory = this.executionHistory.slice(-50);
    }
  }

  getPerformanceStats() {
    return {
      totalRequests: this.executionHistory.length,
      successRate: this.executionHistory.filter(e => e.success).length / this.executionHistory.length,
      patternUsage: this.executionHistory.reduce((acc, e) => {
        acc[e.pattern || 'Unknown'] = (acc[e.pattern || 'Unknown'] || 0) + 1;
        return acc;
      }, {}),
      averageToolsUsed: this.executionHistory.reduce((sum, e) => sum + (e.toolsUsed || 0), 0) / this.executionHistory.length
    };
  }
}

module.exports = EnhancedAIAgent;