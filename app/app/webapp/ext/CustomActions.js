sap.ui.define([
    "sap/ui/core/Fragment",
    "sap/m/MessageToast",
    "sap/ui/model/json/JSONModel",
    "sap/m/Popover", // Popover explizit importieren, falls nicht schon durch Fragment
    "sap/m/PlacementType" // Für die Platzierung des Popovers
], function (Fragment, MessageToast, JSONModel, Popover, PlacementType) {
    "use strict";

    var oChatPopover; // Wird jetzt ein Popover sein
    var oChatModel;
    var fragmentControllerInstance; // Für die Event-Handler im Fragment

    function initializeChatIfNeeded(pageController, oOpeningControl) { // oOpeningControl ist der Button
        if (!oChatModel) {
            oChatModel = new JSONModel({
                chatHistory: [],
                userInput: ""
            });
        }
        pageController._view.setModel(oChatModel, "chat");

        if (!oChatPopover) {
            fragmentControllerInstance = {
                _pageController: pageController,
                _openingControl: oOpeningControl, // Merken für späteres Schließen, falls nötig

                // Keine explizite Schließen-Aktion vom Popover-Inhalt, da Klick außerhalb schließt
                // Aber wir behalten die Send-Logik
                onSendChatMessageInPopover: function () { // Umbenannt zur Klarheit
                    var sUserInput = oChatModel.getProperty("/userInput");
                    if (!sUserInput || !sUserInput.trim()) {
                        MessageToast.show("Please enter a message.");
                        return;
                    }
                    var aHistory = oChatModel.getProperty("/chatHistory");
                    aHistory.push({ type: "user", text: sUserInput });
                    oChatModel.setProperty("/chatHistory", aHistory);
                    oChatModel.setProperty("/userInput", "");

                    var oExtensionAPI = this._pageController.getExtensionAPI();
                    
                    aHistory.push({ type: "assistant", text: "Thinking..." });
                    oChatModel.setProperty("/chatHistory", aHistory);

                    oExtensionAPI.invokeAction("StammtischService.callClaude", {
                        parameters: { prompt: sUserInput }
                    }).then(function (oResultContext) {
                        var resultData = oResultContext.getObject();
                        var sResponse = (resultData && resultData.response) ? resultData.response : "No valid response.";
                        aHistory.pop();
                        aHistory.push({ type: "assistant", text: sResponse });
                        oChatModel.setProperty("/chatHistory", aHistory);
                    }).catch(function (oError) {
                        console.error("AI Action Error:", oError);
                        MessageToast.show("Error calling AI: " + (oError.message || "Unknown error"));
                        aHistory.pop();
                        aHistory.push({ type: "assistant", text: "Error: Could not get response." });
                        oChatModel.setProperty("/chatHistory", aHistory);
                    });
                },
                // Diese Methode wird vom Popover selbst aufgerufen, wenn er geschlossen wird
                // (z.B. durch Klick außerhalb)
                afterPopoverClose: function() {
                    console.log("Chat Popover closed");
                    // Hier könnte Aufräumlogik stehen, falls nötig
                }
            };

            return Fragment.load({
                id: pageController._view.getId() + "--aiChatPopover", // Eindeutige ID
                name: "sap.stammtisch.ui.app.ext.AIChatPopover",   // NEUER FRAGMENTNAME
                controller: fragmentControllerInstance
            }).then(function (oLoadedPopover) {
                oChatPopover = oLoadedPopover;
                pageController._view.addDependent(oChatPopover);
                // Event-Handler für das Schließen des Popovers registrieren
                oChatPopover.attachAfterClose(fragmentControllerInstance.afterPopoverClose, fragmentControllerInstance);
                return oChatPopover;
            });
        }
        return Promise.resolve(oChatPopover);
    }

    return {
        onOpenAIChatDialog: function (oEvent) { // oEvent ist hier das Button-Press-Event
            var pageController = this; // 'this' ist der FE Page Controller
            var oButton = oEvent.getSource(); // Der Button, der geklickt wurde

            console.log("onOpenAIChatDialog (for Popover) called. Page Controller:", pageController);

            initializeChatIfNeeded(pageController, oButton).then(function(popoverInstance){
                if (popoverInstance) {
                    popoverInstance.setModel(oChatModel, "chat");
                    if (popoverInstance.isOpen()) {
                        popoverInstance.close();
                    } else {
                        // Popover relativ zum geklickten Button öffnen
                        popoverInstance.openBy(oButton);
                    }
                } else {
                    MessageToast.show("Could not load chat popover.");
                }
            }).catch(function(err){
                MessageToast.show("Error initializing chat: " + err.message);
                console.error("Error initializing chat:", err);
            });
        }
    };
});