sap.ui.define(['sap/fe/test/ObjectPage'], function(ObjectPage) {
    'use strict';

    var CustomPageDefinitions = {
        actions: {},
        assertions: {}
    };

    return new ObjectPage(
        {
            appId: 'sap.stammtisch.ui.app',
            componentId: 'StammtischeObjectPage',
            contextPath: '/Stammtische'
        },
        CustomPageDefinitions
    );
});