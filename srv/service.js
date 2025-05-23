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

  this.on('callClaude', async (req) => {
    try {
      const capllmplugin = await cds.connect.to("cap-llm-plugin");

      const { prompt } = req.data;
      if (!prompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      // Get chat model configuration
      const CHAT_MODEL = "claude-3.5";
      const chatModelConfig = cds.env.requires["gen-ai-hub"]?.[CHAT_MODEL];

      if (!chatModelConfig) {
        throw new Error(`Chat model configuration for ${CHAT_MODEL} not found`);
      }

      // Create chat request payload
      const payload = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 10000,
        messages: [{
          role: "user",
          content: prompt || "Hello, Claude" // Use query if provided
        }]
      };

      const response = await capllmplugin.getChatCompletionWithConfig(
        chatModelConfig,
        payload
      );

      let messageContent = "No valid response content found."; // Standard-Fallback

      if (response && response.content && Array.isArray(response.content) && response.content.length > 0) {
        const textContentBlock = response.content.find(block => block.type === "text");
        if (textContentBlock && typeof textContentBlock.text === 'string') {
          messageContent = textContentBlock.text;
        } else {
          console.warn("No 'text' block found in Claude response content or text is missing. Stringifying entire response content.");
          messageContent = JSON.stringify(response.content);
        }
      } else if (response) {
        console.warn("Claude response structure is not as expected. Stringifying entire response.");
        messageContent = JSON.stringify(response);
      }

      console.log("Extracted/Fallback message content:", messageContent);
      return { response: messageContent };
      
    } catch (error) {
      console.error('Error testing prompt:', error);
      console.error('Detailed error:', JSON.stringify(error, null, 2));
      throw new Error(`AI request failed: ${error.message}`);
    }
  });
});