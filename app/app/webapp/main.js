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
                MessageToast.show("Please enter a message.");
                return;
            }

            var aHistory = oChatModel.getProperty("/chatHistory");
            aHistory.push({ type: "user", text: sUserInput });
            oChatModel.setProperty("/userInput", ""); // Eingabe leeren
            oChatModel.refresh(true);
            scrollToBottomInSidePanelChat();

            aHistory.push({ type: "assistant", text: "Thinking..." });
            oChatModel.setProperty("/chatHistory", aHistory);
            oChatModel.refresh(true);
            scrollToBottomInSidePanelChat();

            // AI Call über die Fiori Elements Component anstoßen
            if (oFeAppComponentInstance && oFeAppComponentInstance.invokeAIActionOnCurrentPage) {
                oFeAppComponentInstance.invokeAIActionOnCurrentPage(sUserInput, oChatModel);
            } else {
                console.error("FE App Component or invokeAIActionOnCurrentPage method not available.");
                aHistory.pop(); // "Thinking..." entfernen
                aHistory.push({ type: "assistant", text: "Error: AI Call setup incomplete." });
                oChatModel.setProperty("/chatHistory", aHistory);
                oChatModel.refresh(true);
                scrollToBottomInSidePanelChat();
            }
        }
    };

    function scrollToBottomInSidePanelChat() {
        if (oDynamicSideContent) {
            var scrollContainer = sap.ui.core.Fragment.byId("chatSidePanelFragmentGlobal", "chatHistoryScrollContainerInSidePanel");
            if (scrollContainer) {
                setTimeout(function() {
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
        }).then(function(oChatPanelContent) {
            // KORREKTUR HIER:
            oDynamicSideContent.addSideContent(oChatPanelContent);
        }).catch(function(oError){
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


/* sap.ui.define([
    "sap/ui/core/ComponentContainer"
], function (ComponentContainer) {
    "use strict";

    sap.ui.getCore().attachInit(function () {
        new ComponentContainer({
            name: "sap.stammtisch.ui.app", // Dein FE App Namespace
            settings: {
                id: "app" // ID deiner FE App Component
            },
            async: true
        }).placeAt("appHost");
    });
}); */