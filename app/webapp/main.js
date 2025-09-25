sap.ui.define([
    "sap/ui/core/Component",
    "sap/ui/core/ComponentContainer",
    "sap/ui/layout/DynamicSideContent",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/App",
    "sap/m/Page",
    "sap/m/Bar",
    "sap/m/Title",
    "sap/m/MessageToast"
], (Component, ComponentContainer, DynamicSideContent, Fragment, JSONModel, App, Page, Bar, Title, MessageToast) => {
    "use strict";

    // Modern class-based approach for Chat functionality
    class ChatManager {
        constructor() {
            this.chatModel = null;
            this.notificationsModel = null;
            this.dynamicSideContent = null;
            this.feAppComponentInstance = null;
            this.currentRecognition = null;
            this.serviceUrl = "/service/stammtisch"; // Service URL from manifest.json
            this.notificationsEventSource = null;
        }

        // Initialize chat model with welcome message
        initializeChatModel() {
            this.chatModel = new JSONModel({
                chatHistory: [],
                userInput: "",
                isTyping: false,
                statusMessage: ""
            });

            const welcomeHistory = [{
                type: "system",
                text: "👋 Welcome! I'm your AI assistant. I can help you with questions, tasks, and provide information. What would you like to know?",
                timestamp: this.getCurrentTimestamp()
            }];

            this.chatModel.setProperty("/chatHistory", welcomeHistory);
        }

        initializeNotificationsModel() {
            this.notificationsModel = new JSONModel({
                items: [],
                unreadCount: 0,
                hasNew: false
            });
        }

        formatNotificationForDisplay(item) {
            if (!item) return item;
            const formatted = { ...item };
            const fromEntry = item.from || {};
            const nameCandidate = fromEntry.name || fromEntry.displayName;
            const addressCandidate = fromEntry.address || fromEntry.emailAddress;
            formatted.fromDisplay = nameCandidate || addressCandidate || 'Unbekannter Absender';

            if (item.agentContext) {
                formatted.agentContext = item.agentContext;
            }

            formatted.hasAttachments = Boolean(item.hasAttachments);

            const categoryRaw = typeof item.category === 'string' ? item.category.trim() : '';
            const category = categoryRaw || 'Notification';
            formatted.category = category;
            formatted.categoryState = this.mapCategoryToState(category);

            const rawSummary = typeof item.summary === 'string'
                ? item.summary
                : (item.bodyPreview || '');

            let preparedSummary = String(rawSummary || '')
                .replace(/\r\n/g, '\n')
                .trim();

            if (preparedSummary) {
                // Normalize whitespace around explicit line breaks
                preparedSummary = preparedSummary
                    .split('\n')
                    .map((line) => line.trim().replace(/\s{2,}/g, ' '))
                    .filter(Boolean)
                    .join('\n');

                // If no line breaks provided, insert one after sentence endings for readability
                if (!preparedSummary.includes('\n')) {
                    preparedSummary = preparedSummary.replace(/\.\s+/g, '.\n');
                }
            } else {
                preparedSummary = 'Keine Zusammenfassung verfügbar.';
            }

            formatted.summary = preparedSummary;

            if (item.receivedDateTime) {
                const date = new Date(item.receivedDateTime);
                if (!Number.isNaN(date.getTime())) {
                    const now = new Date();
                    const todayKey = now.toDateString();
                    const yesterday = new Date(now);
                    yesterday.setDate(now.getDate() - 1);
                    const targetKey = date.toDateString();
                    const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
                    const dateFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
                    if (targetKey === todayKey) {
                        formatted.receivedLabel = `Heute ${timeFormatter.format(date)}`;
                    } else if (targetKey === yesterday.toDateString()) {
                        formatted.receivedLabel = `Gestern ${timeFormatter.format(date)}`;
                    } else {
                        formatted.receivedLabel = `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
                    }
                } else {
                    formatted.receivedLabel = '';
                }
            } else {
                formatted.receivedLabel = '';
            }

            if (!formatted.subject) {
                formatted.subject = 'Ohne Betreff';
            }

            return formatted;
        }

        buildMailActionPrompt(mailItem) {
            const agentContext = mailItem?.agentContext;
            const contextObject = typeof agentContext === 'string' ? { context: agentContext } : agentContext;
            const contextJson = contextObject ? JSON.stringify(contextObject, null, 2) : null;
            const subject = mailItem?.subject || 'Ohne Betreff';
            const baseSummary = mailItem?.summary || '';
            const category = mailItem?.category || 'Notification';

            return [
                'Du bist ein KI-Assistent, der Anwendern hilft, sinnvolle Folgeaktionen für eingehende E-Mails zu planen.',
                'Analysiere den untenstehenden JSON-Kontext und schlage drei konkrete nächste Schritte vor.',
                'Formatiere die Ausgabe als nummerierte Liste. Für jede Aktion: kurze Beschreibung, warum sie sinnvoll ist, und falls nötig welche Informationen fehlen.',
                'Die Felder "bodyText" (bereinigter Volltext) und "bodyHtml" (sanitisierte HTML-Struktur) enthalten den vollständigen Inhalt.',
                'Antworte auf Deutsch und fasse dich prägnant.',
                '',
                `Betreff: ${subject}`,
                `Kategorie (Vorhersage): ${category}`,
                baseSummary ? `Zusammenfassung: ${baseSummary}` : '',
                '',
                'E-Mail-Kontext (JSON):',
                contextJson || 'Kein Kontext verfügbar'
            ].filter(Boolean).join('\n');
        }

        async sendMailContextToAgent(mailItem) {
            if (!mailItem) {
                this.setStatusMessage('Keine Mail ausgewählt', 2000);
                return;
            }

            if (!mailItem.agentContext) {
                this.setStatusMessage('Kein Kontext für diese Mail verfügbar', 3000);
                return;
            }

            const subject = mailItem.subject || 'Ohne Betreff';
            const userMessage = `Welche Aktionen empfiehlst du für die E-Mail "${subject}"?`;

            this.addMessage('user', userMessage);
            this.chatModel.setProperty('/isTyping', true);
            this.setStatusMessage('Agent analysiert die E-Mail...', 0);

            const prompt = this.buildMailActionPrompt(mailItem);

            const pop = sap.ui.core.Fragment.byId('chatSidePanelFragmentGlobal', 'notificationsPopover');
            if (pop && pop.isOpen && pop.isOpen()) {
                pop.close();
                this.setHasNew(false);
            }

            try {
                const response = await this.callLLMViaOperationBinding(prompt);
                this.handleAIResponse(response);
                this.setStatusMessage('Agent-Antwort erhalten', 2000);
            } catch (error) {
                console.error('Error while sending mail to agent:', error);
                this.handleAIError(error.message || 'Analyse fehlgeschlagen');
            }
        }

        setNotifications(items) {
            const arr = Array.isArray(items) ? items : [];
            const formatted = arr.map((entry) => this.formatNotificationForDisplay(entry));
            this.notificationsModel.setProperty('/items', formatted);
            this.notificationsModel.setProperty('/unreadCount', formatted.length);
            if (formatted.length === 0) {
                this.notificationsModel.setProperty('/hasNew', false);
            }
            this.notificationsModel.refresh(true);
        }

        mapCategoryToState(category) {
            switch (category) {
                case 'Action needed':
                case 'To Respond':
                    return 'Warning';
                case 'Completed':
                    return 'Success';
                case 'Notification':
                case 'FYI':
                case 'Meeting Update':
                    return 'Information';
                default:
                    return 'None';
            }
        }

        addNotification(item) {
            const items = this.notificationsModel.getProperty('/items') || [];
            if (!items.find(x => x.id === item.id)) {
                const formatted = this.formatNotificationForDisplay(item);
                items.unshift(formatted);
                if (items.length > 20) items.length = 20;
                this.setNotifications(items);
                return true;
            }
            return false;
        }

        removeNotificationById(id) {
            const items = this.notificationsModel.getProperty('/items') || [];
            const filtered = items.filter(x => x.id !== id);
            this.setNotifications(filtered);
        }

        setHasNew(flag) {
            const next = Boolean(flag);
            const current = Boolean(this.notificationsModel.getProperty('/hasNew'));
            if (current === next) {
                return;
            }
            this.notificationsModel.setProperty('/hasNew', next);
            this.notificationsModel.refresh(true);
        }

        setupNotificationsSSE() {
            try {
                if (this.notificationsEventSource) {
                    try { this.notificationsEventSource.close(); } catch (e) {}
                }
                const url = `${this.serviceUrl}/notifications/stream`;
                const es = new EventSource(url);
                this.notificationsEventSource = es;

                es.onmessage = (ev) => {
                    try {
                        const msg = JSON.parse(ev.data || '{}');
                        if (msg.type === 'init' && Array.isArray(msg.items)) {
                            this.setNotifications(msg.items);
                            this.setHasNew(false);
                        } else if (msg.type === 'new' && msg.item) {
                            const added = this.addNotification(msg.item);
                            if (added) {
                                const pop = sap.ui.core.Fragment.byId('chatSidePanelFragmentGlobal', 'notificationsPopover');
                                const isOpen = pop?.isOpen && pop.isOpen();
                                this.setHasNew(!isOpen);
                            }
                        } else if (msg.type === 'read' && msg.id) {
                            this.removeNotificationById(msg.id);
                        } else if (msg.type === 'error' && msg.message) {
                            console.warn('Notifications error:', msg.message);
                        }
                    } catch (e) {
                        console.warn('Failed to parse notifications message', e);
                    }
                };

                es.onerror = () => {
                    // Let browser retry automatically; show a subtle status
                    this.setStatusMessage('Verbindung zu Benachrichtigungen gestört. Versuche erneut...', 2000);
                };
            } catch (e) {
                console.warn('Failed to setup notifications SSE:', e);
            }
        }

        // Get current timestamp in HH:MM format
        getCurrentTimestamp() {
            return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        // Smooth scroll to bottom of chat
        scrollToBottom() {
            if (!this.dynamicSideContent) return;

            const scrollContainer = sap.ui.core.Fragment.byId(
                "chatSidePanelFragmentGlobal",
                "chatHistoryScrollContainerInSidePanel"
            );

            if (scrollContainer) {
                setTimeout(() => scrollContainer.scrollTo(0, 99999, 300), 100);
            }
        }

        async callLLMViaOperationBinding(prompt) {
            try {
                if (!this.feAppComponentInstance) {
                    throw new Error("FE Component not available");
                }

                const oDataModel = this.feAppComponentInstance.getModel();

                if (!oDataModel) {
                    throw new Error("OData Model not found");
                }

                // Erstelle Operation Binding für unbound Action
                const oOperationBinding = oDataModel.bindContext("/callLLM(...)");

                // Setze Parameter
                oOperationBinding.setParameter("prompt", prompt);

                // Führe Action aus
                await oOperationBinding.execute();

                // Hole Ergebnis
                const oContext = oOperationBinding.getBoundContext();
                const result = oContext.getObject();

                console.log("Claude operation result:", result);

                return result.response || "No response received";

            } catch (error) {
                console.error("Error in callLLMViaOperationBinding:", error);
                throw error;
            }
        }

        // Update status message with auto-clear
        setStatusMessage(message, duration = 3000) {
            this.chatModel.setProperty("/statusMessage", message);
            if (duration > 0) {
                setTimeout(() => this.chatModel.setProperty("/statusMessage", ""), duration);
            }
        }

        // Add message to chat history
        addMessage(type, text, timestamp = this.getCurrentTimestamp()) {
            const history = this.chatModel.getProperty("/chatHistory");
            history.push({ type, text, timestamp });
            this.chatModel.setProperty("/chatHistory", history);
            this.chatModel.refresh(true);
            this.scrollToBottom();
        }

        // Remove last "Thinking..." message
        removeThinkingMessage() {
            const history = this.chatModel.getProperty("/chatHistory");
            if (history.length > 0 && history[history.length - 1].text === "Thinking...") {
                history.pop();
                this.chatModel.setProperty("/chatHistory", history);
            }
        }

        // Handle AI response
        handleAIResponse(responseText) {
            this.removeThinkingMessage();
            this.addMessage("assistant", responseText);
            this.chatModel.setProperty("/isTyping", false);
            this.chatModel.setProperty("/statusMessage", "");
        }

        // Handle AI errors
        handleAIError(errorMessage) {
            this.removeThinkingMessage();
            this.addMessage("assistant", `I apologize, but I encountered an error: ${errorMessage}`);
            this.chatModel.setProperty("/isTyping", false);
            this.setStatusMessage("Error occurred", 5000);
        }

        // Call Claude service via HTTP
        async callLLMService(prompt) {
            try {
                // Get CSRF token first
                const csrfToken = await this.getCSRFToken();

                // Prepare the request
                const requestOptions = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify({
                        prompt: prompt
                    })
                };

                // Make the actual call to Claude service
                const response = await fetch(`${this.serviceUrl}/callLLM`, requestOptions);

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();

                // Handle response from Claude
                if (data && data.response) {
                    return data.response;
                } else {
                    throw new Error("No valid response from Claude service");
                }

            } catch (error) {
                console.error("Error calling Claude service:", error);
                throw error;
            }
        }

        // Get CSRF token for OData service calls
        async getCSRFToken() {
            try {
                const response = await fetch(`${this.serviceUrl}/`, {
                    method: 'GET',
                    headers: {
                        'X-CSRF-Token': 'Fetch'
                    }
                });

                return response.headers.get('X-CSRF-Token') || '';
            } catch (error) {
                console.warn("Could not fetch CSRF token:", error);
                return '';
            }
        }

        // Modern clipboard copy with fallback
        async copyToClipboard(text) {
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                    this.setStatusMessage("Copied to clipboard", 2000);
                } else {
                    // Fallback for older browsers
                    const textArea = document.createElement("textarea");
                    textArea.value = text;
                    textArea.style.position = "fixed";
                    textArea.style.opacity = "0";
                    document.body.appendChild(textArea);
                    textArea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textArea);
                    this.setStatusMessage("Copied to clipboard", 2000);
                }
            } catch (error) {
                console.error('Copy failed:', error);
                this.setStatusMessage("Failed to copy", 2000);
            }
        }

        // Modern speech recognition
        startVoiceInput() {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

            if (!SpeechRecognition) {
                this.setStatusMessage("Voice input not supported in this browser");
                return;
            }

            // Stop any existing recognition
            if (this.currentRecognition) {
                this.currentRecognition.stop();
            }

            this.currentRecognition = new SpeechRecognition();
            Object.assign(this.currentRecognition, {
                continuous: false,
                interimResults: false,
                lang: 'en-US'
            });

            this.setStatusMessage("Listening...", 0);

            this.currentRecognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                this.chatModel.setProperty("/userInput", transcript);
                this.setStatusMessage("Voice input received", 2000);
            };

            this.currentRecognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                this.setStatusMessage("Voice input failed");
            };

            this.currentRecognition.onend = () => {
                this.currentRecognition = null;
                this.setStatusMessage("");
            };

            this.currentRecognition.start();
        }

        scrollToBottomEnhanced() {
            if (!this.dynamicSideContent) return;

            const scrollContainer = sap.ui.core.Fragment.byId(
                "chatSidePanelFragmentGlobal",
                "chatHistoryScrollContainerInSidePanel"
            );

            if (scrollContainer) {
                // Warte bis HTML-Content gerendert ist
                setTimeout(() => {
                    scrollContainer.scrollTo(0, 99999, 500);

                    // Trigger re-rendering für FormattedText mit HTML
                    const chatList = sap.ui.core.Fragment.byId(
                        "chatSidePanelFragmentGlobal",
                        "chatMessagesList"
                    );
                    if (chatList) {
                        chatList.getModel("chat").refresh(true);
                    }
                }, 150);
            }
        }

        // Erweiterte addMessage Methode mit HTML-Unterstützung
        addMessageEnhanced(type, text, timestamp = this.getCurrentTimestamp()) {
            const history = this.chatModel.getProperty("/chatHistory");

            // Spezielle Behandlung für HTML-Content
            let processedText = text;
            if (type === "assistant" && text.includes('<')) {
                // HTML-Content erkannt - stelle sicher, dass es sicher ist
                processedText = this.sanitizeHTMLContent(text);
            }

            history.push({
                type,
                text: processedText,
                timestamp,
                isHTML: text.includes('<') // Flag für HTML-Content
            });

            this.chatModel.setProperty("/chatHistory", history);
            this.chatModel.refresh(true);

            // Verwende enhanced scrolling für HTML-Content
            this.scrollToBottomEnhanced();
        }

        // HTML Content Sanitization (Basis-Sicherheit)
        sanitizeHTMLContent(html) {
            // Erlaubte Tags für AI-Antworten
            const allowedTags = [
                'p', 'br', 'strong', 'em', 'code', 'pre',
                'h1', 'h2', 'h3', 'ul', 'ol', 'li',
                'div', 'span', 'a'
            ];

            // Entferne potentiell gefährliche Attribute
            let sanitized = html.replace(/on\w+="[^"]*"/gi, ''); // onclick, onload, etc.
            sanitized = sanitized.replace(/javascript:/gi, ''); // javascript: URLs
            sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ''); // script tags

            return sanitized;
        }

        // Link-Handler für AI-Links
        handleAILink(event) {
            const link = event.getSource();
            const url = link.data("url");

            if (url) {
                sap.m.MessageBox.confirm(
                    `Möchten Sie diesen Link öffnen?\n\n${url}`,
                    {
                        title: "Externen Link öffnen",
                        onClose: (action) => {
                            if (action === sap.m.MessageBox.Action.OK) {
                                window.open(url, '_blank', 'noopener,noreferrer');
                            }
                        }
                    }
                );
            }
        }
    }


    // Create singleton instance
    const chatManager = new ChatManager();

    // Modern Chat Controller with arrow functions
    const chatController = {
        onToggleNotifications() {
            const pop = sap.ui.core.Fragment.byId('chatSidePanelFragmentGlobal', 'notificationsPopover');
            const btn = sap.ui.core.Fragment.byId('chatSidePanelFragmentGlobal', 'notificationsButton');
            if (pop && btn) {
                if (pop.isOpen && pop.isOpen()) {
                    pop.close();
                    chatManager.setHasNew(false);
                } else {
                    pop.openBy(btn);
                    chatManager.setHasNew(false);
                }
            }
        },

        onOpenNotificationLink(event) {
            const ctx = event.getSource().getBindingContext('notifications');
            const obj = ctx?.getObject();
            const url = obj?.webLink;
            if (url) {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        },

        async onMarkNotificationRead(event) {
            try {
                const ctx = event.getSource().getBindingContext('notifications');
                const obj = ctx?.getObject();
                if (!obj?.id) return;
                const csrf = await chatManager.getCSRFToken();
                const res = await fetch(`${chatManager.serviceUrl}/notifications/markRead`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
                    body: JSON.stringify({ id: obj.id })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                // Optimistic: locally remove (server also broadcasts)
                chatManager.removeNotificationById(obj.id);
            } catch (e) {
                chatManager.setStatusMessage('Konnte nicht als gelesen markieren', 3000);
            }
        },

        onCloseNotification(event) {
            const ctx = event.getSource().getBindingContext('notifications');
            const obj = ctx?.getObject();
            if (obj?.id) {
                chatManager.removeNotificationById(obj.id);
            }
        },

        async onSendNotificationToAgent(event) {
            try {
                const ctx = event.getSource().getBindingContext('notifications');
                const obj = ctx?.getObject();
                await chatManager.sendMailContextToAgent(obj);
            } catch (e) {
                console.error('Failed to send mail context to agent:', e);
                chatManager.setStatusMessage('Konnte Mail nicht an Agent senden', 3000);
            }
        },
        async onSendChatMessageInSidePanel() {
            // Get the input field to ensure we have the latest value
            const inputField = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatInputField");
            const currentValue = inputField?.getValue()?.trim() || "";
            
            // Update model with current input field value if needed
            if (currentValue !== chatManager.chatModel.getProperty("/userInput")) {
                chatManager.chatModel.setProperty("/userInput", currentValue);
            }
            
            const userInput = currentValue;

            if (!userInput) {
                chatManager.setStatusMessage("Please enter a message.");
                return;
            }

            // Add user message
            chatManager.addMessage("user", userInput);

            // Clear input and set loading state
            chatManager.chatModel.setProperty("/userInput", "");
            chatManager.chatModel.setProperty("/isTyping", true);
            chatManager.setStatusMessage("Sending...", 0);

            // Add thinking placeholder

            try {
                // Call Claude service directly
                const aiResponse = await chatManager.callLLMViaOperationBinding(userInput);

                // Handle successful response
                chatManager.handleAIResponse(aiResponse);
                chatManager.setStatusMessage("Response received", 2000);

            } catch (error) {
                console.error("Claude service call failed:", error);
                chatManager.handleAIError(error.message || "Failed to get response from AI service");
            }
        },


        onClearChatHistory() {
            sap.m.MessageBox.confirm(
                "Start a new chat? This will clear your current conversation.",
                {
                    title: "New Chat",
                    onClose: (action) => {
                        if (action === sap.m.MessageBox.Action.OK) {
                            // Reset chat state
                            Object.assign(chatManager.chatModel.getData(), {
                                chatHistory: [],
                                userInput: "",
                                isTyping: false,
                                statusMessage: "New chat started"
                            });

                            // Add welcome message
                            chatManager.addMessage(
                                "system",
                                "New conversation started. How can I help you today?"
                            );

                            chatManager.setStatusMessage("New chat started");
                        }
                    }
                }
            );
        },

        async onCopyMessage(event) {
            const context = event.getSource().getBindingContext("chat");
            const messageText = context.getProperty("text");
            await chatManager.copyToClipboard(messageText);
        },

        onAttachFile() {
            // Placeholder for future file upload functionality
            chatManager.setStatusMessage("File attachment coming soon...");
        },

        onVoiceInput() {
            chatManager.startVoiceInput();
        },

        // Code-Block Kopier-Funktion
        async onCopyCodeBlock(event) {
            const button = event.getSource();
            const codeBlock = button.getParent().getParent(); // Navigation zum Code-Block
            const codeContent = codeBlock.querySelector('.ai-code-content');

            if (codeContent) {
                const code = codeContent.textContent;
                await chatManager.copyToClipboard(code);
                button.setText("Kopiert!");
                setTimeout(() => button.setText("Kopieren"), 2000);
            }
        },

        // Erweiterte Nachrichtenbehandlung
        onSendChatMessageInSidePanelEnhanced: async function () {
            const userInput = chatManager.chatModel.getProperty("/userInput")?.trim();

            if (!userInput) {
                chatManager.setStatusMessage("Bitte geben Sie eine Nachricht ein.");
                return;
            }

            // Add user message mit enhanced method
            chatManager.addMessageEnhanced("user", userInput);

            // Clear input and set loading state
            chatManager.chatModel.setProperty("/userInput", "");
            chatManager.chatModel.setProperty("/isTyping", true);
            chatManager.setStatusMessage("AI denkt nach...", 0);

            try {
                // Call Claude service
                const aiResponse = await chatManager.callLLMViaOperationBinding(userInput);

                // Handle successful HTML response
                chatManager.handleAIResponseEnhanced(aiResponse);
                chatManager.setStatusMessage("Antwort erhalten", 2000);

            } catch (error) {
                console.error("Claude service call failed:", error);
                chatManager.handleAIError(error.message || "Fehler beim Abrufen der AI-Antwort");
            }
        },

        // Erweiterte AI Response Handler
        handleAIResponseEnhanced(responseText) {
            this.removeThinkingMessage();

            // Verwende enhanced addMessage für HTML-Content
            this.addMessageEnhanced("assistant", responseText);

            this.chatModel.setProperty("/isTyping", false);
            this.chatModel.setProperty("/statusMessage", "");

            // Zusätzliche UI-Updates für HTML-Content
            this.enhanceRenderedHTMLContent();
        },

        // Post-Processing für gerenderten HTML-Content
        enhanceRenderedHTMLContent() {
            setTimeout(() => {
                // Füge Event-Listener für AI-Links hinzu
                const aiLinks = document.querySelectorAll('.ai-link');
                aiLinks.forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        const url = link.getAttribute('data-url');
                        if (url) {
                            sap.m.MessageBox.confirm(
                                `Möchten Sie diesen Link öffnen?\n\n${url}`,
                                {
                                    title: "Externen Link öffnen",
                                    onClose: (action) => {
                                        if (action === sap.m.MessageBox.Action.OK) {
                                            window.open(url, '_blank', 'noopener,noreferrer');
                                        }
                                    }
                                }
                            );
                        }
                    });
                });

                // Füge Kopieren-Buttons zu Code-Blöcken hinzu
                const codeBlocks = document.querySelectorAll('.ai-code-block');
                codeBlocks.forEach(block => {
                    if (!block.querySelector('.ai-copy-button')) {
                        const copyButton = document.createElement('button');
                        copyButton.className = 'ai-copy-button';
                        copyButton.innerHTML = '📋 Kopieren';
                        copyButton.onclick = async () => {
                            const code = block.querySelector('.ai-code-content').textContent;
                            await chatManager.copyToClipboard(code);
                            copyButton.innerHTML = '✅ Kopiert!';
                            setTimeout(() => copyButton.innerHTML = '📋 Kopieren', 2000);
                        };

                        const header = block.querySelector('.ai-code-header');
                        if (header) {
                            header.appendChild(copyButton);
                        }
                    }
                });
            }, 100);
        }


    };

    // Enhanced global functions
    const globalFunctions = {
        addAIResponse: (responseText) => chatManager.handleAIResponse(responseText),
        addSystemMessage: (message) => chatManager.addMessage("system", message),
        handleAIError: (errorMessage) => chatManager.handleAIError(errorMessage),
        triggerChatScroll: () => chatManager.scrollToBottom()
    };

    // Assign to window for external access
    Object.assign(window, globalFunctions);

    // Modern keyboard shortcuts with better event handling
    const setupKeyboardShortcuts = () => {
        document.addEventListener('keydown', (event) => {
            const { key, ctrlKey, metaKey, shiftKey } = event;
            const inputField = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatInputField");
            const isInputFocused = inputField?.getFocusDomRef() === document.activeElement;

            if (!isInputFocused) return;

            // Enter without Shift to send message (Shift+Enter for new line)
            if (key === 'Enter' && !shiftKey) {
                event.preventDefault();
                chatController.onSendChatMessageInSidePanel();
            }

            // Escape to clear input
            if (key === 'Escape') {
                chatManager.chatModel.setProperty("/userInput", "");
            }
        });
    };

    // Modern app initialization with async/await
    const initializeApp = async () => {
        try {
            // Initialize chat model
            chatManager.initializeChatModel();
            chatManager.initializeNotificationsModel();

            // Create DynamicSideContent
            chatManager.dynamicSideContent = new DynamicSideContent("appDynamicSideContentGlobal", {
                sideContentVisible: false,
                height: "100%"
            });
            chatManager.dynamicSideContent.setModel(chatManager.chatModel, "chat");
            chatManager.dynamicSideContent.setModel(chatManager.notificationsModel, "notifications");

            // Load chat fragment
            const chatPanelContent = await Fragment.load({
                id: "chatSidePanelFragmentGlobal",
                name: "sap.stammtisch.ui.app.ext.ChatSidePanelContent",
                controller: chatController
            });
            chatManager.dynamicSideContent.addSideContent(chatPanelContent);

            // Create Fiori Elements component
            const feComponent = await Component.create({
                name: "sap.stammtisch.ui.app",
                id: "feAppComponentCore"
            });

            chatManager.feAppComponentInstance = feComponent;

            // Set external dependencies if available
            if (feComponent.setExternalDependencies) {
                feComponent.setExternalDependencies(
                    chatManager.chatModel,
                    chatManager.dynamicSideContent
                );
            } else {
                console.warn(
                    "Method 'setExternalDependencies' not found on FE Component. " +
                    "Chat/SidePanel might not be fully functional from custom actions."
                );
            }

            // Create component container and app structure
            const componentContainer = new ComponentContainer({
                component: feComponent,
                height: "100%"
            });
            chatManager.dynamicSideContent.addMainContent(componentContainer);

            const mainPage = new Page("mainAppPage", {
                showHeader: false,
                content: [chatManager.dynamicSideContent],
                height: "100%"
            });

            const appControl = new App({
                pages: [mainPage],
                height: "100%"
            });

            // Mount app
            appControl.placeAt("appHost");

            // Setup keyboard shortcuts
            setupKeyboardShortcuts();

            // Connect notifications stream
            chatManager.setupNotificationsSSE();

            console.log("Application initialized successfully");

        } catch (error) {
            console.error("Failed to initialize application:", error);

            const appHostDiv = document.getElementById("appHost");
            if (appHostDiv) {
                appHostDiv.innerHTML = `
                    <div style="padding: 20px; color: #d32f2f; font-family: Arial, sans-serif;">
                        <h2>Application Error</h2>
                        <p><strong>Error:</strong> ${error.message}</p>
                        <p>Please check the console for more details.</p>
                    </div>
                `;
            }
        }
    };



    // Initialize when SAP UI5 core is ready
    sap.ui.getCore().attachInit(initializeApp);
});
