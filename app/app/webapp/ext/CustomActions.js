sap.ui.define([
    "sap/m/MessageToast"
], function (MessageToast) {
    "use strict";

    function getFEAppComponent(oController) {
        // oController ist hier die FE Page Controller Extension
        if (oController && oController.getOwnerComponent && oController.getOwnerComponent().getAppComponent) {
            return oController.getOwnerComponent().getAppComponent();
        }
        console.error("Could not get FE AppComponent from controller", oController);
        return null;
    }

    // Diese Funktion wird aufgerufen, wenn die Extension initialisiert wird
    // oder bevor die AI-Funktion das erste Mal gebraucht wird.
    function ensureAISendFunctionRegistered(oPageController) {
        var oFEAppComponent = getFEAppComponent(oPageController);
        if (oFEAppComponent && oFEAppComponent.registerAISendFunction && !oFEAppComponent._aiSendFunctionFromCustomAction) { // Nur einmal registrieren
            oFEAppComponent.registerAISendFunction(
                // Diese Funktion wird von der Component aufgerufen und hat den korrekten Scope
                function(sPrompt, oChatModelToUpdate) { // this ist hier die oPageController Instanz
                    var oExtensionAPI = this.getExtensionAPI(); // 'this' ist hier die CustomActions Instanz
                    var aHistory = oChatModelToUpdate.getProperty("/chatHistory"); // "Thinking..." ist schon drin

                    oExtensionAPI.invokeAction("StammtischService.callClaude", {
                        parameters: { prompt: sPrompt }
                    }).then(function (oResultContext) {
                        var resultData = oResultContext.getObject();
                        var sResponse = (resultData && resultData.response) ? resultData.response : "No valid response.";
                        aHistory.pop(); // "Thinking..." entfernen
                        aHistory.push({ type: "assistant", text: sResponse });
                        oChatModelToUpdate.setProperty("/chatHistory", aHistory);
                        oChatModelToUpdate.refresh(true);
                        if (window.triggerChatScroll) window.triggerChatScroll();
                    }.bind(this)).catch(function (oError) {
                        console.error("AI Action Error from CustomActions:", oError);
                        aHistory.pop(); // "Thinking..." entfernen
                        aHistory.push({ type: "assistant", text: "Error: " + (oError.message || "Unknown AI error") });
                        oChatModelToUpdate.setProperty("/chatHistory", aHistory);
                        oChatModelToUpdate.refresh(true);
                        if (window.triggerChatScroll) window.triggerChatScroll();
                    }.bind(this));
                }.bind(oPageController) // Wichtig: 'this' der äußeren Funktion (oPageController) binden!
            );
            console.log("AI Send function registered from CustomActions.");
        }
    }


    return {
        // Wird vom Button im Manifest aufgerufen
        onToggleChatSidePanel: function (/*oEvent*/) { // 'this' ist der FE Page Controller (Extension)
            var oFEAppComponent = getFEAppComponent(this);
            if (oFEAppComponent) {
                var oDynamicSideContent = oFEAppComponent.getDynamicSideContent();
                if (oDynamicSideContent) {
                    oDynamicSideContent.toggleSideContent();
                    // Sicherstellen, dass die AI-Sende-Funktion registriert ist,
                    // falls das Panel geöffnet wird und Chat-Funktionalität benötigt wird.
                    if (oDynamicSideContent.getSideContentVisible()) {
                         ensureAISendFunctionRegistered(this);
                         if (window.triggerChatScroll) window.triggerChatScroll(); // Ggf. zum Boden scrollen
                    }
                } else {
                    MessageToast.show("SidePanel control not found via FE Component.");
                }
            } else {
                MessageToast.show("FE Application Component not found.");
            }
        }

        // Die onSendChatMessageInSidePanel ist nicht mehr hier, sondern im oChatFragmentController in main.js
    };
});