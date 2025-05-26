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
            this.dynamicSideContent = null;
            this.feAppComponentInstance = null;
            this.currentRecognition = null;
            this.serviceUrl = "/service/stammtisch"; // Service URL from manifest.json
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

        async callClaudeViaOperationBinding(prompt) {
            try {
                if (!this.feAppComponentInstance) {
                    throw new Error("FE Component not available");
                }

                const oDataModel = this.feAppComponentInstance.getModel();

                if (!oDataModel) {
                    throw new Error("OData Model not found");
                }

                // Erstelle Operation Binding für unbound Action
                const oOperationBinding = oDataModel.bindContext("/callClaude(...)");

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
                console.error("Error in callClaudeViaOperationBinding:", error);
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
        async callClaudeService(prompt) {
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
                const response = await fetch(`${this.serviceUrl}/callClaude`, requestOptions);

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
    }


    // Create singleton instance
    const chatManager = new ChatManager();

    // Modern Chat Controller with arrow functions
    const chatController = {
        async onSendChatMessageInSidePanel() {
            const userInput = chatManager.chatModel.getProperty("/userInput")?.trim();

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
            chatManager.addMessage("assistant", "Thinking...");

            try {
                // Call Claude service directly
                const aiResponse = await chatManager.callClaudeViaOperationBinding(userInput);

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
            const { ctrlKey, metaKey, key } = event;
            const inputField = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatInputField");
            const isInputFocused = inputField?.getFocusDomRef() === document.activeElement;

            if (!isInputFocused) return;

            // Ctrl/Cmd + Enter to send message
            if ((ctrlKey || metaKey) && key === 'Enter') {
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

            // Create DynamicSideContent
            chatManager.dynamicSideContent = new DynamicSideContent("appDynamicSideContentGlobal", {
                sideContentVisible: false,
                height: "100%"
            });
            chatManager.dynamicSideContent.setModel(chatManager.chatModel, "chat");

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