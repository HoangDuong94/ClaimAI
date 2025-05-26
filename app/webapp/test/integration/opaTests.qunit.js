sap.ui.require(
    [
        'sap/fe/test/JourneyRunner',
        'sap/stammtisch/ui/app/test/integration/FirstJourney',
		'sap/stammtisch/ui/app/test/integration/pages/StammtischeList',
		'sap/stammtisch/ui/app/test/integration/pages/StammtischeObjectPage',
		'sap/stammtisch/ui/app/test/integration/pages/TeilnehmerObjectPage'
    ],
    function(JourneyRunner, opaJourney, StammtischeList, StammtischeObjectPage, TeilnehmerObjectPage) {
        'use strict';
        var JourneyRunner = new JourneyRunner({
            // start index.html in web folder
            launchUrl: sap.ui.require.toUrl('sap/stammtisch/ui/app') + '/index.html'
        });

       
        JourneyRunner.run(
            {
                pages: { 
					onTheStammtischeList: StammtischeList,
					onTheStammtischeObjectPage: StammtischeObjectPage,
					onTheTeilnehmerObjectPage: TeilnehmerObjectPage
                }
            },
            opaJourney.run
        );
    }
);