sap.ui.define(['sap/fe/test/ListReport'], function(ListReport) {
    'use strict';

    const CustomPageDefinitions = {
        actions: {},
        assertions: {}
    };

    return new ListReport(
        {
            appId: 'kfz.claims.ui.app',
            componentId: 'ClaimsList',
            contextPath: '/Claims'
        },
        CustomPageDefinitions
    );
});
