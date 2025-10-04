sap.ui.require(
    [
        'sap/fe/test/JourneyRunner',
        'kfz/claims/ui/app/test/integration/FirstJourney',
        'kfz/claims/ui/app/test/integration/pages/ClaimsList',
        'kfz/claims/ui/app/test/integration/pages/ClaimsObjectPage',
        'kfz/claims/ui/app/test/integration/pages/ClaimDocumentsObjectPage'
    ],
    function(JourneyRunner, opaJourney, ClaimsList, ClaimsObjectPage, ClaimDocumentsObjectPage) {
        'use strict';
        const journeyRunner = new JourneyRunner({
            launchUrl: sap.ui.require.toUrl('kfz/claims/ui/app') + '/index.html'
        });

        journeyRunner.run(
            {
                pages: {
                    onTheClaimsList: ClaimsList,
                    onTheClaimsObjectPage: ClaimsObjectPage,
                    onTheClaimDocumentsObjectPage: ClaimDocumentsObjectPage
                }
            },
            opaJourney.run
        );
    }
);
