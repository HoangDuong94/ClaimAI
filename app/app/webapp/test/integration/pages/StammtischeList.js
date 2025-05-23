sap.ui.define(['sap/fe/test/ListReport'], function(ListReport) {
    'use strict';

    var CustomPageDefinitions = {
        actions: {},
        assertions: {}
    };

    return new ListReport(
        {
            appId: 'sap.stammtisch.ui.app',
            componentId: 'StammtischeList',
            contextPath: '/Stammtische'
        },
        CustomPageDefinitions
    );
});