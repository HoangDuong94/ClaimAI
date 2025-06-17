using { sap.stammtisch as StammtischModel } from '../db/schema';
using from '../app/annotations'; 

service StammtischService @(path: '/service/stammtisch') { 

    @odata.draft.enabled // Aktiviere Draft-Modus für diese Entität
    entity Stammtische as projection on StammtischModel.Stammtische {
        *,
        // Navigation Properties explizit exponieren
        praesentator : redirected to Praesentatoren,
        teilnehmer : redirected to Teilnehmer
    };

    entity Praesentatoren as projection on StammtischModel.Praesentatoren {
        *,
        stammtische : redirected to Stammtische
    };
    
    entity Teilnehmer as projection on StammtischModel.Teilnehmer {
        *,
        stammtisch : redirected to Stammtische
    };

    action callLLM (prompt: String) returns { response: String };

}