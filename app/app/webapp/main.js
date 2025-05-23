sap.ui.define([
    "sap/ui/core/Component",
    "sap/ui/core/ComponentContainer",
    "sap/ui/layout/DynamicSideContent",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/App", // Als Root-Container für das DynamicSideContent
    "sap/m/Page", // Um dem DynamicSideContent eine Titelzeile zu geben (optional)
    "sap/m/Bar",
    "sap/m/Title",
    "sap/m/MessageToast"
], function (Component, ComponentContainer, DynamicSideContent, Fragment, JSONModel, App, Page, Bar, Title, MessageToast) {
    "use strict";

    var oChatModel;
    var oDynamicSideContent;
    var oFeAppComponentInstance; // Instanz unserer Fiori Elements App Component

    // Kleiner Controller für das Chat-Fragment
    var oChatFragmentController = {

        onSendChatMessageInSidePanel: function () {
            var sUserInput = oChatModel.getProperty("/userInput");
            if (!sUserInput || !sUserInput.trim()) {
                oChatModel.setProperty("/statusMessage", "Please enter a message.");
                setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 3000);
                return;
            }

            // User-Nachricht zur Historie hinzufügen
            var aHistory = oChatModel.getProperty("/chatHistory");
            var timestamp = this.getCurrentTimestamp();

            aHistory.push({
                type: "user",
                text: sUserInput.trim(),
                timestamp: timestamp
            });

            // Eingabe leeren und Status setzen
            oChatModel.setProperty("/userInput", "");
            oChatModel.setProperty("/isTyping", true);
            oChatModel.setProperty("/statusMessage", "Sending...");
            oChatModel.refresh(true);

            // Zum Ende scrollen
            scrollToBottomInSidePanelChat();

            // AI Response vorbereiten
            aHistory.push({
                type: "assistant",
                text: "Thinking...",
                timestamp: this.getCurrentTimestamp()
            });
            oChatModel.setProperty("/chatHistory", aHistory);
            oChatModel.refresh(true);
            scrollToBottomInSidePanelChat();

            // AI Call über die Fiori Elements Component anstoßen
            if (oFeAppComponentInstance && oFeAppComponentInstance.invokeAIActionOnCurrentPage) {
                oFeAppComponentInstance.invokeAIActionOnCurrentPage(sUserInput, oChatModel);
            } else {
                console.error("FE App Component or invokeAIActionOnCurrentPage method not available.");
                this.handleAIError("AI service not available. Please check your configuration.");
            }
        },

        onClearChatHistory: function () {
            sap.m.MessageBox.confirm("Start a new chat? This will clear your current conversation.", {
                title: "New Chat",
                onClose: function (sAction) {
                    if (sAction === sap.m.MessageBox.Action.OK) {
                        oChatModel.setProperty("/chatHistory", []);
                        oChatModel.setProperty("/userInput", "");
                        oChatModel.setProperty("/statusMessage", "New chat started");
                        oChatModel.setProperty("/isTyping", false);

                        // Willkommen-Nachricht hinzufügen
                        var aHistory = oChatModel.getProperty("/chatHistory");
                        aHistory.push({
                            type: "system",
                            text: "New conversation started. How can I help you today?",
                            timestamp: oChatFragmentController.getCurrentTimestamp()
                        });
                        oChatModel.setProperty("/chatHistory", aHistory);
                        oChatModel.refresh(true);

                        setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 3000);
                    }
                }
            });
        },

        onCopyMessage: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("chat");
            var sMessageText = oContext.getProperty("text");

            // Copy to clipboard
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(sMessageText).then(function () {
                    oChatModel.setProperty("/statusMessage", "Copied to clipboard");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 2000);
                }).catch(function (err) {
                    console.error('Failed to copy text: ', err);
                    oChatModel.setProperty("/statusMessage", "Failed to copy");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 2000);
                });
            } else {
                // Fallback for older browsers
                var textArea = document.createElement("textarea");
                textArea.value = sMessageText;
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    oChatModel.setProperty("/statusMessage", "Copied to clipboard");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 2000);
                } catch (err) {
                    console.error('Fallback copy failed: ', err);
                    oChatModel.setProperty("/statusMessage", "Failed to copy");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 2000);
                }
                document.body.removeChild(textArea);
            }
        },

        onAttachFile: function () {
            // Platzhalter für File-Upload-Funktionalität
            oChatModel.setProperty("/statusMessage", "File attachment coming soon...");
            setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 3000);
        },

        onVoiceInput: function () {
            // Moderne Voice-Input-Funktionalität
            if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
                var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                var recognition = new SpeechRecognition();

                recognition.continuous = false;
                recognition.interimResults = false;
                recognition.lang = 'en-US';

                oChatModel.setProperty("/statusMessage", "Listening...");

                recognition.onresult = function (event) {
                    var transcript = event.results[0][0].transcript;
                    oChatModel.setProperty("/userInput", transcript);
                    oChatModel.setProperty("/statusMessage", "Voice input received");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 2000);
                };

                recognition.onerror = function (event) {
                    oChatModel.setProperty("/statusMessage", "Voice input failed");
                    setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 3000);
                };

                recognition.onend = function () {
                    oChatModel.setProperty("/statusMessage", "");
                };

                recognition.start();
            } else {
                oChatModel.setProperty("/statusMessage", "Voice input not supported in this browser");
                setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 3000);
            }
        },

        getCurrentTimestamp: function () {
            var now = new Date();
            return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },

        handleAIError: function (errorMessage) {
            var aHistory = oChatModel.getProperty("/chatHistory");
            // Letzten "Thinking..." Eintrag entfernen
            if (aHistory.length > 0 && aHistory[aHistory.length - 1].text === "Thinking...") {
                aHistory.pop();
            }

            // Fehlermeldung hinzufügen
            aHistory.push({
                type: "assistant",
                text: "I apologize, but I encountered an error: " + errorMessage,
                timestamp: this.getCurrentTimestamp()
            });

            oChatModel.setProperty("/chatHistory", aHistory);
            oChatModel.setProperty("/isTyping", false);
            oChatModel.setProperty("/statusMessage", "Error occurred");
            oChatModel.refresh(true);
            scrollToBottomInSidePanelChat();

            setTimeout(() => oChatModel.setProperty("/statusMessage", ""), 5000);
        },

        addSystemMessage: function (message) {
            var aHistory = oChatModel.getProperty("/chatHistory");
            aHistory.push({
                type: "system",
                text: message,
                timestamp: this.getCurrentTimestamp()
            });
            oChatModel.setProperty("/chatHistory", aHistory);
            oChatModel.refresh(true);
            scrollToBottomInSidePanelChat();
        }
    };

    // Erweiterte globale Funktionen
    window.addAIResponse = function (responseText) {
        var aHistory = oChatModel.getProperty("/chatHistory");

        // Letzten "Thinking..." Eintrag entfernen
        if (aHistory.length > 0 && aHistory[aHistory.length - 1].text === "Thinking...") {
            aHistory.pop();
        }

        // AI Response hinzufügen
        aHistory.push({
            type: "assistant",
            text: responseText,
            timestamp: oChatFragmentController.getCurrentTimestamp()
        });

        oChatModel.setProperty("/chatHistory", aHistory);
        oChatModel.setProperty("/isTyping", false);
        oChatModel.setProperty("/statusMessage", "");
        oChatModel.refresh(true);
        scrollToBottomInSidePanelChat();
    };

    window.addSystemMessage = function (message) {
        oChatFragmentController.addSystemMessage(message);
    };

    window.handleAIError = function (errorMessage) {
        oChatFragmentController.handleAIError(errorMessage);
    };

    // Erweiterte Chat-Model-Initialisierung
    function initializeChatModel() {
        oChatModel = new JSONModel({
            chatHistory: [],
            userInput: "",
            isTyping: false,
            statusMessage: ""
        });

        // Moderne Willkommen-Nachricht hinzufügen
        var welcomeHistory = [{
            type: "system",
            text: "👋 Welcome! I'm your AI assistant. I can help you with questions, tasks, and provide information. What would you like to know?",
            timestamp: oChatFragmentController.getCurrentTimestamp()
        }];

        oChatModel.setProperty("/chatHistory", welcomeHistory);
    }

    // Verbesserte Scroll-Funktion
    function scrollToBottomInSidePanelChat() {
        if (oDynamicSideContent) {
            var scrollContainer = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatHistoryScrollContainerInSidePanel");
            if (scrollContainer) {
                setTimeout(function () {
                    scrollContainer.scrollTo(0, 99999, 300);
                }, 100);
            }
        }
    }

    // Keyboard-Shortcuts
    document.addEventListener('keydown', function (event) {
        // Ctrl/Cmd + Enter um Nachricht zu senden
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            var inputField = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatInputField");
            if (inputField && inputField.getFocusDomRef() === document.activeElement) {
                event.preventDefault();
                oChatFragmentController.onSendChatMessageInSidePanel();
            }
        }

        // Escape um Input zu leeren
        if (event.key === 'Escape') {
            var inputField = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatInputField");
            if (inputField && inputField.getFocusDomRef() === document.activeElement) {
                oChatModel.setProperty("/userInput", "");
            }
        }
    });

    function scrollToBottomInSidePanelChat() {
        if (oDynamicSideContent) {
            var scrollContainer = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatHistoryScrollContainerInSidePanel");
            if (scrollContainer) {
                setTimeout(function () {
                    scrollContainer.scrollTo(0, 99999, 200); // Scroll ans Ende
                }, 100);
            }
        }
    }

    // Globale Funktion für die Component, um das Scrollen auszulösen
    window.triggerChatScroll = scrollToBottomInSidePanelChat;


    sap.ui.getCore().attachInit(function () {
        // 1. ChatModel erstellen
        oChatModel = new JSONModel({
            chatHistory: [],
            userInput: ""
        });

        // 2. DynamicSideContent erstellen
        oDynamicSideContent = new DynamicSideContent("appDynamicSideContentGlobal", { // Oder sap.ui.layout.DynamicSideContent, falls explizit gewünscht
            sideContentVisible: false,
            height: "100%"
        });
        oDynamicSideContent.setModel(oChatModel, "chat"); // ChatModel für Side Panel setzen

        // 3. Chat-Fragment laden und als sideContent setzen
        Fragment.load({
            id: "chatSidePanelFragmentGlobal", // Eindeutige ID
            name: "sap.stammtisch.ui.app.ext.ChatSidePanelContent",
            controller: oChatFragmentController
        }).then(function (oChatPanelContent) {
            // KORREKTUR HIER:
            oDynamicSideContent.addSideContent(oChatPanelContent);
        }).catch(function (oError) {
            console.error("Error loading chat side panel fragment: ", oError);
        });

        // 4. Fiori Elements App-Komponente erstellen
        Component.create({
            name: "sap.stammtisch.ui.app",
            id: "feAppComponentCore"
        }).then(function (oComponent) {
            oFeAppComponentInstance = oComponent;

            if (oFeAppComponentInstance.setExternalDependencies) {
                oFeAppComponentInstance.setExternalDependencies(oChatModel, oDynamicSideContent);
            } else {
                console.warn("Method 'setExternalDependencies' not found on FE Component. Chat/SidePanel might not be fully functional from custom actions.");
            }

            var oComponentContainer = new ComponentContainer({
                component: oFeAppComponentInstance,
                height: "100%"
            });
            oDynamicSideContent.addMainContent(oComponentContainer);

            var oAppControl = new App({
                pages: [
                    new Page("mainAppPage", {
                        showHeader: false,
                        content: [oDynamicSideContent],
                        height: "100%"
                    })
                ],
                height: "100%"
            });
            oAppControl.placeAt("appHost");

        }).catch(function (oError) {
            console.error("Failed to load Fiori Elements component:", oError.stack);
            var appHostDiv = document.getElementById("appHost");
            if (appHostDiv) {
                appHostDiv.innerText = "Error loading application: " + oError.message;
            }
        });
    });
});

