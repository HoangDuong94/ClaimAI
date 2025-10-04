sap.ui.define(['sap/fe/test/ObjectPage'], function(ObjectPage) {
    'use strict';

    const CustomPageDefinitions = {
        actions: {},
        assertions: {}
    };

    return new ObjectPage(
        {
            appId: 'kfz.claims.ui.app',
            componentId: 'ClaimDocumentsObjectPage',
            contextPath: '/ClaimDocuments'
        },
        CustomPageDefinitions
    );
});
