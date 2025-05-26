const cds = require('@sap/cds');


function logDbConfig() {
  if (cds.db) {
    console.log("========== EFFECTIVE DB CONFIG (Hybrid Start from Root) ==========");
    console.log("CDS Profiles:", cds.env.profiles);
    console.log("DB Service Kind:", cds.db.kind); // Sollte 'postgres' sein
    console.log("DB Service Name (aus cds.requires):", cds.db.name); // Sollte 'db' sein
    console.log("Effective DB Credentials (aus cds.env.requires.db):", JSON.stringify(cds.env.requires.db?.credentials, null, 2));
    // Vorsicht: Obige Zeile zeigt nur, was konfiguriert ist, nicht unbedingt, was der Treiber *intern* verwendet, aber es ist ein guter Hinweis.
    console.log("Full cds.env.requires.db (Hybrid Start from Root):", JSON.stringify(cds.env.requires.db, null, 2));
    console.log("================================================================");
  }
}

if (cds.db) {
  logDbConfig();
} else {
  cds.once('connected', (service) => { // cds.once, damit es nicht mehrfach bei Reconnects loggt
    if (service.name === 'db') { // Nur für den DB-Service loggen
      logDbConfig();
    }
  });
}

module.exports = cds.service.impl(async function () {
  // Connect to cap-llm-plugin service


  this.on('READ', 'Stammtische', async (req, next) => {
    console.log("----- Reading Stammtische (Hybrid Start from Root) -----");
    console.log("Current Profile during request:", cds.env.profiles);
    try {
      const result = await next();
      console.log("----- Stammtische read successfully (Hybrid Start from Root) -----");
      return result;
    } catch (error) {
      console.error("----- Error reading Stammtische (Hybrid Start from Root) -----", error);
      throw error; // Wichtig, den Fehler weiterzuwerfen
    }
  });

  this.on('callLLM', async (req) => {

    const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');

    try {
      const { prompt } = req.data;
      if (!prompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      const orchestrationClient = new OrchestrationClient({
        llm: {
          model_name: "gpt-4", 
        },
        templating: {
          template: [{ role: 'user', content: '{{?user_prompt}}' }]
        }
      });

      const llmParams = {
        max_tokens_to_sample: 10000, // Entspricht deinem 'max_tokens'
      };

      const response = await orchestrationClient.chatCompletion({
        inputParams: {
          user_prompt: prompt
        },
        params: llmParams // Übergabe der LLM-spezifischen Parameter
      });

      const messageContent = response.getContent();

      if (typeof messageContent !== 'string') {
        console.warn("AI SDK response content is not a string. Stringifying entire response object.", response);
        // Das SDK sollte bei Erfolg einen String liefern. Falls nicht, ist etwas unerwartet.
        // Um einen Fehler zu vermeiden, geben wir das gesamte Objekt als String zurück.
        return { response: JSON.stringify(response) };
      }

      console.log("AI SDK Extracted message content:", messageContent);
      return { response: messageContent };

    } catch (error) {
      console.error('Error calling AI with SAP AI SDK:', error.message);
      let detailedMessage = `AI request failed with SAP AI SDK: ${error.message}`;

      // Das AI SDK verwendet oft das SAP Cloud SDK darunter, das Axios-Fehler werfen kann
      if (error.isAxiosError && error.response) {
        console.error('AI SDK Error Details:', JSON.stringify(error.response.data || error.response.statusText, null, 2));
        detailedMessage += ` - Details: ${JSON.stringify(error.response.data || error.response.statusText)}`;
      } else if (error.cause) { // Manchmal ist der ursprüngliche Fehler in 'cause'
        console.error('AI SDK Error Cause:', JSON.stringify(error.cause, null, 2));
        detailedMessage += ` - Cause: ${JSON.stringify(error.cause, null, 2)}`;
      } else if (error.stack) {
        console.error('AI SDK Error Stack:', error.stack);
      }

      const capError = new Error(detailedMessage);
      if (error.response) capError.response = error.response; // Original-Response beibehalten, falls vorhanden
      if (error.cause) capError.cause = error.cause;
      throw capError;
    }

  });
});