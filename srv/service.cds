using { sap.stammtisch as StammtischModel } from '../db/schema'; 

service StammtischService @(path: '/service/stammtisch') { 

    @odata.draft.enabled // Aktiviere Draft-Modus für diese Entität
    entity Stammtische    as projection on StammtischModel.Stammtische;

    entity Praesentatoren as projection on StammtischModel.Praesentatoren;
    entity Teilnehmer     as projection on StammtischModel.Teilnehmer;

    action callClaude (prompt: String) returns { response: String };

}