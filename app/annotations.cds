using ClaimsService as service from '../srv/service';
using { kfz.claims as model } from '../db/schema';

/* =========================================================
 * Claims (Root Entity)
 * =======================================================*/
annotate service.Claims with @(
    UI.HeaderInfo : {
        TypeName       : 'Schadenfall',
        TypeNamePlural : 'Schadenfälle',
        Title          : { Value : claim_number },
        Description    : { Value : status }
    },

    UI.LineItem : [
        { Value : claim_number, Label : 'Schaden-Nr.' },
        { Value : status },
        { Value : received_at },
        { Value : claimant_name },
        { Value : incident_date },
        { Value : incident_location },
        { Value : estimated_cost, ![@UI.Importance] : #High },
        { Value : severity_score, Label : 'Schweregrad' },
        { Value : fraud_score, Label : 'Betrugsindikator' }
    ],

    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'ClaimGeneralInfo',
            Label : 'Schadeninformationen',
            Target: '@UI.FieldGroup#ClaimSummary'
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'ClaimDocumentsFacet',
            Label : 'Dokumente',
            Target: 'documents/@UI.LineItem'
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'NotesFacet',
            Label : 'Notizen',
            Target: '@UI.FieldGroup#ClaimNotes'
        }
    ],

    UI.FieldGroup #ClaimSummary : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            { Value : claim_number },
            { Value : status },
            { Value : received_at },
            { Value : incident_date },
            { Value : incident_location },
            { Value : policy_number },
            { Value : vehicle_license },
            { Value : vehicle_vin },
            { Value : claimant_name },
            { Value : claimant_email },
            { Value : claimant_phone },
            { Value : estimated_cost },
            { Value : severity_score },
            { Value : fraud_score }
        ]
    },

    UI.FieldGroup #ClaimNotes : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            { Value : description_short, ![@UI.MultiLineText] : true },
            { Value : notes, ![@UI.MultiLineText] : true }
        ]
    }
);

/* =========================================================
 * ClaimDocuments (Sub Entity)
 * =======================================================*/
annotate service.ClaimDocuments with @(
    UI.LineItem : [
        { Value : filename },
        { Value : doc_type },
        { Value : parsed_meta },
        { Value : extracted_text }
    ],
    UI.HeaderInfo : {
        TypeName       : 'Dokument',
        TypeNamePlural : 'Dokumente',
        Title          : { Value : filename },
        Description    : { Value : doc_type }
    }
);

annotate model.ClaimDocuments with {
    parsed_meta      @UI.MultiLineText : true;
    extracted_text   @UI.MultiLineText : true;
};
