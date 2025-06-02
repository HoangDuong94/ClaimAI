const cds = require('@sap/cds');
// Import des Enhanced AI Agent
const EnhancedAIAgent = require('./agents/enhanced-agent');

function logDbConfig() {
  if (cds.db) {
    console.log("========== EFFECTIVE DB CONFIG ==========");
    console.log("CDS Profiles:", cds.env.profiles);
    console.log("DB Service Kind:", cds.db.kind);
    console.log("=========================================");
  }
}

if (cds.db) {
  logDbConfig();
} else {
  cds.once('connected', (service) => {
    if (service.name === 'db') {
      logDbConfig();
    }
  });
}

module.exports = cds.service.impl(async function () {

  // Initialize Enhanced AI Agent
  const enhancedAgent = new EnhancedAIAgent();

  this.on('READ', 'Stammtische', async (req, next) => {
    console.log("----- Reading Stammtische -----");
    try {
      const result = await next();
      console.log("----- Stammtische read successfully -----");
      return result;
    } catch (error) {
      console.error("----- Error reading Stammtische -----", error);
      throw error;
    }
  });

  /**
   * Enhanced AI Assistant mit Multi-Pattern Support
   */
  this.on('callLLM', async (req) => {
    try {
      const { prompt } = req.data;

      if (!prompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      console.log('=== ENHANCED AI AGENT REQUEST ===');
      console.log('User Prompt:', prompt);

      // Verwende den Enhanced AI Agent für die Verarbeitung
      const response = await enhancedAgent.processRequest(prompt);

      console.log('=== ENHANCED AI AGENT RESPONSE ===');
      console.log('Response Length:', response.length);

      // Performance Stats für Monitoring
      const stats = enhancedAgent.getPerformanceStats();
      console.log('Agent Performance Stats:', stats);

      return { response };

    } catch (error) {
      console.error('=== ENHANCED AI AGENT ERROR ===');
      console.error('Error:', error.message);

      const userFriendlyError = this.createUserFriendlyErrorMessage(error);
      return { response: userFriendlyError };
    }
  });

  /**
   * Agent Performance Analytics Endpoint (optional)
   */
  this.on('getAgentStats', async (req) => {
    try {
      const stats = enhancedAgent.getPerformanceStats();
      return { stats };
    } catch (error) {
      console.error('Error getting agent stats:', error);
      return { error: error.message };
    }
  });

  /**
   * Benutzerfreundliche Fehlermeldungen
   */
  this.createUserFriendlyErrorMessage = function (error) {
    if (error.message?.includes('timeout')) {
      return `⏱️ **Zeitüberschreitung**: Die AI-Verarbeitung dauerte zu lange.

**Versuchen Sie:**
- Eine kürzere, spezifischere Frage zu stellen
- Es in einem Moment erneut zu versuchen`;
    }

    if (error.message?.includes('database') || error.message?.includes('DB')) {
      return `🗄️ **Datenbankfehler**: Problem beim Zugriff auf die Daten.

**Lösungsansätze:**
- Versuchen Sie es in einem Moment erneut
- Kontaktieren Sie den Administrator bei anhaltenden Problemen`;
    }

    if (error.message?.includes('classification') || error.message?.includes('orchestration')) {
      return `🤖 **AI-Verarbeitungsfehler**: Der Agent konnte Ihre Anfrage nicht vollständig verarbeiten.

**Alternative:**
- Formulieren Sie Ihre Frage anders
- Versuchen Sie eine einfachere Anfrage
- Beispiel: "Zeige mir alle Stammtische" oder "Suche nach CAP"`;
    }

    return `❌ **Unerwarteter Fehler**

Der AI-Agent ist temporär nicht verfügbar. Bitte versuchen Sie es später erneut.

**Ihre Anfrage kann möglicherweise auch direkt in der Anwendung bearbeitet werden.**`;
  };

});