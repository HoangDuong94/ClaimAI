namespace sap.stammtisch;

using { cuid, managed, temporal } from '@sap/cds/common';

entity Praesentatoren : cuid, managed {
    @Common.Label : 'Name'
    @Common.Text : {
        $value : name,
        textArrangement : #TextFirst // oder #TextOnly
    }
    name          : String(100) not null;

    @Common.Label : 'E-Mail'
    email         : String;

    @Common.Label : 'LinkedIn'
    linkedin      : String;

    // Diese Komposition erlaubt es, auf der Präsentator-Objektseite eine Tabelle
    // mit den Stammtischen dieses Präsentators anzuzeigen.
    stammtische   : Composition of many Stammtische
                      on stammtische.praesentator = $self;
}

entity Stammtische : cuid, managed {
    key ID        : UUID @(Core.Computed : true);

    @Common.Label : 'Thema'
    thema         : String(255) not null;

    @Common.Label : 'Datum'
    datum         : DateTime not null;

    @Common.Label : 'Ort'
    ort           : String(100);

    @Common.Label : 'Notizen'
    notizen       : LargeString;

    @Common.Label : 'Präsentator'
    praesentator  : Association to Praesentatoren;

    teilnehmer    : Composition of many Teilnehmer
                      on teilnehmer.stammtisch = $self;
}

entity Teilnehmer : cuid, managed {
    key ID        : UUID @(Core.Computed : true);

    @Common.Label : 'Name des Teilnehmers'
    name          : String(100) not null;

    @Common.Label : 'E-Mail des Teilnehmers'
    email         : String;
    stammtisch    : Association to Stammtische;
}