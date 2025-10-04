sap.ui.define([
    'sap/ui/test/opaQunit'
], function(opaTest) {
    'use strict';

    const Journey = {
        run: function() {
            QUnit.module('Claims journey');

            opaTest('Start application', function(Given, When, Then) {
                Given.iStartMyApp();

                Then.onTheClaimsList.iSeeThisPage();
            });

            opaTest('Navigate to Claim ObjectPage', function(Given, When, Then) {
                When.onTheClaimsList.onFilterBar().iExecuteSearch();

                Then.onTheClaimsList.onTable().iCheckRows();

                When.onTheClaimsList.onTable().iPressRow(0);
                Then.onTheClaimsObjectPage.iSeeThisPage();
            });

            opaTest('Teardown', function(Given, When, Then) {
                Given.iTearDownMyApp();
            });
        }
    };

    return Journey;
});
