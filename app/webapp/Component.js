sap.ui.define([
    "sap/fe/core/AppComponent"
    // JSONModel wird nicht mehr hier direkt benötigt, kommt von außen
], function (AppComponent) {
    "use strict";

    return AppComponent.extend("sap.stammtisch.ui.app.Component", {
        metadata: {
            manifest: "json"
        },

        _oChatModelExternal: null,
        _oDynamicSideContentExternal: null,
        _aiSendFunctionFromCustomAction: null, // Für den AI Call aus CustomAction

        init: function () {
            // Standard FE Initialisierung
            AppComponent.prototype.init.apply(this, arguments);
            console.log("Fiori Elements Component 'sap.stammtisch.ui.app' initialized.");
        },

        // Wird von main.js aufgerufen
        setExternalDependencies: function(oChatModel, oDynamicSideContent) {
            this._oChatModelExternal = oChatModel;
            this._oDynamicSideContentExternal = oDynamicSideContent;
        },

        getChatModel: function() {
            return this._oChatModelExternal;
        },

        getDynamicSideContent: function() {
            return this._oDynamicSideContentExternal;
        },

        // Wird von CustomActions.js aufgerufen, um die Sende-Logik zu registrieren
        registerAISendFunction: function(fnSend) {
            this._aiSendFunctionFromCustomAction = fnSend;
        },

        // Wird von main.js (ChatFragmentController) aufgerufen
        invokeAIActionOnCurrentPage: function(sPrompt, oChatModelToUpdate) {
            if (this._aiSendFunctionFromCustomAction) {
                // Ruft die in CustomActions.js definierte Funktion auf,
                // die den korrekten `this`-Kontext (ExtensionAPI) hat.
                this._aiSendFunctionFromCustomAction(sPrompt, oChatModelToUpdate);
            } else {
                console.error("AI Send function from CustomAction not registered on FE component.");
                var aHistory = oChatModelToUpdate.getProperty("/chatHistory");
                aHistory.pop(); // "Thinking..." entfernen
                aHistory.push({ type: "assistant", text: "Error: AI Call handler not registered." });
                oChatModelToUpdate.setProperty("/chatHistory", aHistory);
                oChatModelToUpdate.refresh(true);
                if (window.triggerChatScroll) window.triggerChatScroll();
            }
        }
    });
});