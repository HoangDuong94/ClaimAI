namespace sap.stammtisch; 

using { cuid, managed, temporal } from '@sap/cds/common';

entity Praesentatoren : cuid, managed {
    name          : String(100) not null;
    email         : String;
    linkedin      : String;
    stammtische   : Composition of many Stammtische
                      on stammtische.praesentator = $self;
}

entity Stammtische : cuid, managed { // cuid, managed und temporal für Standardfelder
    key ID            : UUID @(Core.Computed : true); // Auto-generierte UUID
    thema         : String(255) not null;
    datum         : DateTime not null;
    ort           : String(100);
    notizen       : LargeString;
    praesentator  : Association to Praesentatoren;
    teilnehmer    : Composition of many Teilnehmer
                      on teilnehmer.stammtisch = $self;
}

entity Teilnehmer : cuid, managed {
    key ID            : UUID @(Core.Computed : true);
    name          : String(100) not null;
    email         : String;
    stammtisch    : Association to Stammtische;
}