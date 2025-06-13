// srv/agents/enhanced-agent.js
/**
 * Enhanced AI Agent System with Dynamic Routing
 * Nutzt AI-basierte Klassifikation ohne Keywords
 */

const DatabaseTools = require('../tools/database-tools');
const MarkdownConverter = require('../utils/markdown-converter');

class EnhancedAIAgent {
  
  constructor() {
    this.dbTools = new DatabaseTools();
    this.executionHistory = [];
    this.currentPlan = null;
    
    // Cache für häufige Klassifikationen
    this.classificationCache = new Map();
    this.cacheMaxSize = 100;
    this.cacheMaxAge = 3600000; // 1 Stunde
  }

  /**
   * DYNAMIC AI ROUTING: Intelligente Klassifikation ohne Keywords
   */
  async classifyRequest(prompt) {
    console.log('=== DYNAMIC ROUTING: AI-based Classification ===');
    
    // Prüfe Cache
    const cachedResult = this.getCachedClassification(prompt);
    if (cachedResult) {
      console.log('Using cached classification');
      return cachedResult;
    }
    
    const classificationPrompt = `Du bist ein intelligenter Request Classifier für die StammtischAI-Anwendung.
Analysiere die Benutzeranfrage und klassifiziere sie basierend auf INTENT und KONTEXT, nicht auf Keywords.

VERFÜGBARE TOOLS IN DER ANWENDUNG:
1. get_stammtische - Alle Stammtische abrufen
2. get_stammtisch_by_id - Einzelnen Stammtisch abrufen
3. search_stammtische - Nach Stammtischen suchen
4. get_praesentatoren - Präsentatoren-Liste
5. get_teilnehmer - Teilnehmer für Stammtisch
6. get_stammtisch_statistics - Umfassende Statistiken
7. get_upcoming_stammtische - Kommende Events

KLASSIFIKATIONS-KATEGORIEN:

**personal_chat** - Der Benutzer möchte:
- Sich vorstellen oder Small Talk machen
- Etwas über den Bot erfahren
- Allgemeine Konversation ohne Datenbezug

**help_task** - Der Benutzer braucht:
- Hilfe zur Anwendung selbst
- Erklärungen zu Funktionen
- Anleitung zur Bedienung

**data_retrieval** - Der Benutzer möchte:
- Spezifische Daten aus der Datenbank
- Listen oder Übersichten
- Einzelne Datensätze

**search_operation** - Der Benutzer möchte:
- Nach bestimmten Inhalten suchen
- Filterkriterien anwenden
- Spezifische Teilmengen finden

**analytical_task** - Der Benutzer möchte:
- Daten analysieren oder auswerten
- Trends oder Muster erkennen
- Statistische Informationen

**complex_workflow** - Der Benutzer braucht:
- Mehrere Datenquellen kombiniert
- Komplexe Berichte
- Orchestrierte Workflows

ANALYSE-PROZESS:
1. Identifiziere die HAUPTINTENTION des Benutzers
2. Bestimme welche DATEN benötigt werden
3. Erkenne die KOMPLEXITÄT der Anfrage
4. Leite die passenden TOOLS ab

ANFRAGE: "${prompt}"

Analysiere und klassifiziere:

<classification>
{
  "category": "kategorie_name",
  "confidence": 0.95,
  "intent": "Was will der Benutzer erreichen?",
  "data_needs": ["welche Daten werden benötigt"],
  "suggested_tools": ["tool1", "tool2"],
  "parameters": {"key": "value"},
  "complexity": "simple|moderate|complex",
  "reasoning": "Kurze Begründung der Klassifikation"
}
</classification>`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4o-mini" }, // Schnelleres Modell
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: classificationPrompt },
        params: { 
          max_tokens_to_sample: 500, 
          temperature: 0.1,
          response_format: { type: "json_object" } // Force JSON output
        }
      });

      const classificationText = response.getContent();
      const match = classificationText.match(/<classification>([\s\S]*?)<\/classification>/);
      
      if (match) {
        const classification = JSON.parse(match[1].trim());
        console.log('AI Classification Result:', classification);
        
        // Cache das Ergebnis
        this.cacheClassification(prompt, classification);
        
        return classification;
      }
      
      // Fallback zu JSON parsing wenn keine Tags
      try {
        const classification = JSON.parse(classificationText);
        this.cacheClassification(prompt, classification);
        return classification;
      } catch (e) {
        console.log('Failed to parse classification, using intelligent fallback');
      }
      
    } catch (error) {
      console.error('AI Classification failed:', error);
    }

    // Intelligenter Fallback ohne Keywords
    return this.intelligentFallback(prompt);
  }

  /**
   * Intelligenter Fallback basierend auf Satzstruktur statt Keywords
   */
  intelligentFallback(prompt) {
    console.log('Using intelligent structural fallback');
    
    // Analysiere Satzstruktur
    const isQuestion = prompt.includes('?') || 
                      prompt.toLowerCase().startsWith('was') ||
                      prompt.toLowerCase().startsWith('wie') ||
                      prompt.toLowerCase().startsWith('wo') ||
                      prompt.toLowerCase().startsWith('wer');
    
    const hasNumbers = /\d+/.test(prompt);
    const isShort = prompt.split(' ').length < 5;
    const isGreeting = isShort && !isQuestion;
    
    // Intent-basierte Klassifikation
    if (isGreeting && isShort) {
      return {
        category: 'personal_chat',
        confidence: 0.7,
        intent: 'Greeting or personal interaction',
        data_needs: [],
        suggested_tools: [],
        parameters: {},
        complexity: 'simple',
        reasoning: 'Short non-question indicates greeting'
      };
    }
    
    if (isQuestion && prompt.length > 20) {
      // Längere Fragen deuten auf Datenabfrage hin
      return {
        category: 'data_retrieval',
        confidence: 0.6,
        intent: 'Information request',
        data_needs: ['stammtisch_data'],
        suggested_tools: ['get_stammtische'],
        parameters: {},
        complexity: 'simple',
        reasoning: 'Question format suggests data request'
      };
    }
    
    // Default: data retrieval
    return {
      category: 'data_retrieval',
      confidence: 0.5,
      intent: 'General information request',
      data_needs: ['general_data'],
      suggested_tools: ['get_stammtische'],
      parameters: {},
      complexity: 'simple',
      reasoning: 'Default classification'
    };
  }

  /**
   * Cache-Management für Performance
   */
  getCachedClassification(prompt) {
    const normalized = prompt.toLowerCase().trim();
    const cached = this.classificationCache.get(normalized);
    
    if (cached && (Date.now() - cached.timestamp < this.cacheMaxAge)) {
      return cached.classification;
    }
    
    return null;
  }

  cacheClassification(prompt, classification) {
    const normalized = prompt.toLowerCase().trim();
    
    // LRU: Entferne älteste Einträge wenn Cache voll
    if (this.classificationCache.size >= this.cacheMaxSize) {
      const firstKey = this.classificationCache.keys().next().value;
      this.classificationCache.delete(firstKey);
    }
    
    this.classificationCache.set(normalized, {
      classification,
      timestamp: Date.now()
    });
  }

  /**
   * INTELLIGENT ORCHESTRATION: Dynamische Task-Planung
   */
  async orchestrateComplexTask(prompt, classification) {
    console.log('=== INTELLIGENT ORCHESTRATOR: Dynamic Planning ===');
    
    const planningPrompt = `Du bist ein intelligenter Task Orchestrator.
Erstelle einen optimalen Ausführungsplan basierend auf dem Intent und den Datenbedarfen.

KLASSIFIKATION:
${JSON.stringify(classification, null, 2)}

BENUTZERANFRAGE: ${prompt}

VERFÜGBARE TOOLS:
- get_stammtische: Alle Events abrufen
- search_stammtische: Gezielt suchen
- get_stammtisch_statistics: Statistiken
- get_praesentatoren: Präsentatoren
- get_upcoming_stammtische: Zukünftige Events

Erstelle einen MINIMALEN aber VOLLSTÄNDIGEN Plan:

<plan>
[
  {
    "step": 1,
    "tool": "tool_name",
    "parameters": {},
    "purpose": "Warum dieser Schritt",
    "expected_output": "Was wir erwarten"
  }
]
</plan>

WICHTIG: Nutze nur die minimal nötigen Tools!`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4o-mini" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: planningPrompt },
        params: { max_tokens_to_sample: 800, temperature: 0.2 }
      });

      const content = response.getContent();
      const planMatch = content.match(/<plan>([\s\S]*?)<\/plan>/);

      if (planMatch) {
        const plan = JSON.parse(planMatch[1].trim());
        console.log('Execution Plan:', plan);
        
        this.currentPlan = { steps: plan };
        return await this.executePlan(plan);
      }
    } catch (error) {
      console.error('Orchestration failed:', error);
    }

    // Fallback zu suggested tools
    return await this.executeToolsFromClassification(classification);
  }

  /**
   * Tool-Ausführung basierend auf Klassifikation
   */
  async executeToolsFromClassification(classification) {
    const results = [];
    
    for (const tool of (classification.suggested_tools || [])) {
      try {
        const result = await this.dbTools.executeTool(
          tool, 
          classification.parameters || {}
        );
        results.push({
          tool,
          result,
          success: true
        });
      } catch (error) {
        results.push({
          tool,
          error: error.message,
          success: false
        });
      }
    }
    
    return results;
  }

  /**
   * SMART RESPONSE GENERATION: Kontextabhängige Antworten
   */
  async generateResponse(prompt, classification, toolResults = []) {
    console.log('=== SMART RESPONSE: Context-aware Generation ===');
    
    // Für personal_chat und help_task keine AI-Generation nötig
    if (classification.category === 'personal_chat') {
      return this.generatePersonalResponse(prompt, classification);
    }
    
    if (classification.category === 'help_task') {
      return this.generateHelpResponse(prompt, classification);
    }
    
    // Für datenbasierte Antworten nutze AI
    const responsePrompt = `Du bist ein hilfreicher Assistant für die StammtischAI-Anwendung.
Erstelle eine benutzerfreundliche Antwort basierend auf den Daten.

BENUTZERANFRAGE: ${prompt}

INTENT: ${classification.intent}

VERFÜGBARE DATEN:
${JSON.stringify(toolResults, null, 2)}

ANFORDERUNGEN:
- Beantworte die Frage DIREKT und PRÄZISE
- Nutze Markdown für bessere Lesbarkeit
- Sei freundlich aber effizient
- Fokussiere auf die relevanten Informationen
- Keine unnötigen Einleitungen

ANTWORT:`;

    try {
      const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
      const client = new OrchestrationClient({
        llm: { model_name: "gpt-4o-mini" },
        templating: { template: [{ role: 'user', content: '{{?user_prompt}}' }] }
      });

      const response = await client.chatCompletion({
        inputParams: { user_prompt: responsePrompt },
        params: { 
          max_tokens_to_sample: 2000, 
          temperature: 0.3,
          presence_penalty: 0.1 // Reduziert Wiederholungen
        }
      });

      return response.getContent();
      
    } catch (error) {
      console.error('Response generation failed:', error);
      return this.generateFallbackResponse(toolResults);
    }
  }

  /**
   * Optimierte Response-Generatoren
   */
  generatePersonalResponse(prompt, classification) {
    const responses = {
      'greeting': `## 👋 Hallo! Willkommen bei StammtischAI!

Ich bin Ihr intelligenter Assistant und helfe Ihnen gerne bei allen Fragen zu Ihren Stammtisch-Events.

**Was kann ich für Sie tun?**
- 📊 Daten und Statistiken abrufen
- 🔍 Nach Events und Teilnehmern suchen
- 📈 Analysen und Auswertungen erstellen

Fragen Sie einfach los!`,

      'identity': `## 🤖 Über mich

Ich bin der StammtischAI Assistant - ein intelligenter Agent, der speziell für die Verwaltung und Analyse Ihrer Stammtisch-Events entwickelt wurde.

**Meine Fähigkeiten:**
- Schnelle Datenabfragen
- Intelligente Suche
- Komplexe Analysen
- Hilfreiche Empfehlungen

Wie kann ich Ihnen helfen?`,

      'default': `## 💬 StammtischAI Assistant

Ich bin hier, um Ihnen bei Ihren Stammtisch-Events zu helfen. Stellen Sie mir gerne eine Frage!`
    };

    // Wähle passende Antwort basierend auf Intent
    const intentType = classification.intent?.toLowerCase().includes('greet') ? 'greeting' :
                      classification.intent?.toLowerCase().includes('identity') ? 'identity' : 
                      'default';
    
    return responses[intentType];
  }

  generateHelpResponse(prompt, classification) {
    return `## 📚 StammtischAI Hilfe

**Verfügbare Funktionen:**

### 📊 Daten abrufen
- "Zeige alle Stammtische"
- "Liste der Präsentatoren"
- "Kommende Events"

### 🔍 Suchen
- "Finde CAP-Workshops"
- "Suche Online-Events"

### 📈 Analysen
- "Statistiken anzeigen"
- "Event-Performance analysieren"

### 💡 Tipps
- Stellen Sie konkrete Fragen für beste Ergebnisse
- Ich kann mehrere Datenquellen kombinieren
- Bei komplexen Analysen erstelle ich detaillierte Berichte

**Wie kann ich Ihnen konkret helfen?**`;
  }

  generateFallbackResponse(toolResults) {
    if (!toolResults || toolResults.length === 0) {
      return "Entschuldigung, ich konnte keine Daten zu Ihrer Anfrage finden.";
    }
    
    const successfulResults = toolResults.filter(r => r.success);
    if (successfulResults.length === 0) {
      return "Es gab einen Fehler beim Abrufen der Daten. Bitte versuchen Sie es erneut.";
    }
    
    // Strukturierte Darstellung der Rohdaten
    let response = "## 📊 Ergebnisse\n\n";
    successfulResults.forEach((result, index) => {
      response += `### ${result.tool}\n\`\`\`json\n${JSON.stringify(result.result.data, null, 2)}\n\`\`\`\n\n`;
    });
    
    return response;
  }

  /**
   * PERFORMANCE MONITORING
   */
  async evaluatePerformance(response, classification, executionTime) {
    const performance = {
      executionTime,
      classificationConfidence: classification.confidence,
      toolsUsed: classification.suggested_tools?.length || 0,
      complexity: classification.complexity,
      cacheHit: false // wird vom Cache gesetzt
    };

    // Schnelle Selbstbewertung
    if (executionTime > 5000) {
      performance.warning = 'Slow execution detected';
    }
    
    if (classification.confidence < 0.6) {
      performance.warning = 'Low classification confidence';
    }

    return performance;
  }

  /**
   * MAIN PROCESSING mit verbessertem Flow
   */
  async processRequest(prompt) {
    console.log('\n=== ENHANCED AI AGENT: Processing Request ===');
    const startTime = Date.now();
    
    try {
      // Step 1: Intelligente Klassifikation
      const classification = await this.classifyRequest(prompt);
      
      let toolResults = [];
      let response = '';

      // Step 2: Kategorie-basierte Verarbeitung
      switch (classification.category) {
        case 'personal_chat':
        case 'help_task':
          // Direkte Antwort ohne Tools
          response = await this.generateResponse(prompt, classification);
          break;
          
        case 'data_retrieval':
        case 'search_operation':
          // Einfache Tool-Ausführung
          toolResults = await this.executeToolsFromClassification(classification);
          response = await this.generateResponse(prompt, classification, toolResults);
          break;
          
        case 'analytical_task':
        case 'complex_workflow':
          // Orchestrierte Ausführung
          toolResults = await this.orchestrateComplexTask(prompt, classification);
          response = await this.generateResponse(prompt, classification, toolResults);
          break;
          
        default:
          // Fallback
          toolResults = await this.executeToolsFromClassification(classification);
          response = await this.generateResponse(prompt, classification, toolResults);
      }

      // Step 3: Performance Monitoring
      const executionTime = Date.now() - startTime;
      const performance = await this.evaluatePerformance(response, classification, executionTime);

      // Step 4: Response-Optimierung
      const htmlResponse = MarkdownConverter.convertForStammtischAI(response);

      // Step 5: Logging
      this.logExecution({
        prompt,
        classification,
        performance,
        success: true
      });

      console.log(`Request processed in ${executionTime}ms`);
      return htmlResponse;

    } catch (error) {
      console.error('Agent processing failed:', error);
      
      this.logExecution({
        prompt,
        error: error.message,
        executionTime: Date.now() - startTime,
        success: false
      });

      return this.generateErrorResponse(error);
    }
  }

  /**
   * Plan-Ausführung
   */
  async executePlan(steps) {
    console.log('=== Executing Plan ===');
    const results = [];
    
    for (const step of steps) {
      console.log(`Step ${step.step}: ${step.purpose}`);
      
      try {
        const toolResult = await this.dbTools.executeTool(
          step.tool, 
          step.parameters || {}
        );
        
        results.push({
          step: step.step,
          tool: step.tool,
          result: toolResult,
          purpose: step.purpose,
          success: true
        });
        
      } catch (error) {
        console.error(`Step ${step.step} failed:`, error);
        results.push({
          step: step.step,
          tool: step.tool,
          error: error.message,
          success: false
        });
      }
    }
    
    return results;
  }

  /**
   * Error Response
   */
  generateErrorResponse(error) {
    return `## ❌ Fehler aufgetreten

Es tut mir leid, aber bei der Verarbeitung ist ein Fehler aufgetreten.

**Fehler:** ${error.message}

**Was Sie tun können:**
- Versuchen Sie es in einem Moment erneut
- Formulieren Sie Ihre Anfrage um
- Kontaktieren Sie den Support bei anhaltenden Problemen

Kann ich Ihnen anderweitig helfen?`;
  }

  /**
   * Execution Logging
   */
  logExecution(details) {
    this.executionHistory.push({
      ...details,
      timestamp: new Date().toISOString()
    });
    
    // Keep last 100 executions
    if (this.executionHistory.length > 100) {
      this.executionHistory = this.executionHistory.slice(-100);
    }
  }

  /**
   * Performance Stats
   */
  getPerformanceStats() {
    const stats = {
      totalRequests: this.executionHistory.length,
      successRate: this.executionHistory.filter(e => e.success).length / this.executionHistory.length,
      averageExecutionTime: 0,
      categoryDistribution: {},
      cacheHitRate: 0
    };

    // Berechne Durchschnitte
    let totalTime = 0;
    let cacheHits = 0;
    
    this.executionHistory.forEach(entry => {
      if (entry.performance?.executionTime) {
        totalTime += entry.performance.executionTime;
      }
      if (entry.performance?.cacheHit) {
        cacheHits++;
      }
      if (entry.classification?.category) {
        stats.categoryDistribution[entry.classification.category] = 
          (stats.categoryDistribution[entry.classification.category] || 0) + 1;
      }
    });

    stats.averageExecutionTime = totalTime / this.executionHistory.length;
    stats.cacheHitRate = cacheHits / this.executionHistory.length;

    return stats;
  }

  /**
   * Cache-Wartung
   */
  clearCache() {
    this.classificationCache.clear();
    console.log('Classification cache cleared');
  }

  pruneCache() {
    const now = Date.now();
    for (const [key, value] of this.classificationCache.entries()) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.classificationCache.delete(key);
      }
    }
  }
}

module.exports = EnhancedAIAgent;