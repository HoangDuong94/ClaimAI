using ClaimsService as service from '../srv/service';
using { kfz.claims as model } from '../db/schema';

/* =========================================================
 * Claims (Root Entity)
 * =======================================================*/
annotate service.Claims with @(
    UI.HeaderInfo : {
        TypeName       : '{i18n>claims.entity.single}',
        TypeNamePlural : '{i18n>claims.entity.plural}',
        Title          : { Value : claim_number },
        Description    : { Value : status }
    },

    UI.LineItem : [
        { Value : claim_number, Label : '{i18n>claims.field.claimNumber}' },
        { Value : status, Label : '{i18n>claims.field.status}' },
        { Value : received_at, Label : '{i18n>claims.field.receivedAt}' },
        { Value : claimant_name, Label : '{i18n>claims.field.claimantName}' },
        { Value : incident_date, Label : '{i18n>claims.field.incidentDate}' },
        { Value : incident_location, Label : '{i18n>claims.field.incidentLocation}' },
        { Value : estimated_cost, Label : '{i18n>claims.field.estimatedCost}', ![@UI.Importance] : #High },
        { Value : severity_score, Label : '{i18n>claims.field.severityScore}' },
        { Value : fraud_score, Label : '{i18n>claims.field.fraudScore}' }
    ],

    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'ClaimGeneralInfo',
            Label : '{i18n>claims.facet.generalInfo}',
            Target: '@UI.FieldGroup#ClaimSummary'
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'ClaimDocumentsFacet',
            Label : '{i18n>claims.facet.documents}',
            Target: 'documents/@UI.LineItem'
        },
        {
            $Type : 'UI.CollectionFacet',
            ID    : 'AttachmentsFacet',
            Label : 'Anhänge',
            Facets: [
                {
                    $Type : 'UI.ReferenceFacet',
                    ID    : 'AttachmentsTable',
                    Label : 'Anhänge',
                    Target: 'attachments/@UI.LineItem'
                },
                {
                    $Type : 'UI.ReferenceFacet',
                    ID    : 'AttachmentActions',
                    Label : 'Upload',
                    Target: '@UI.FieldGroup#AttachmentActions'
                }
            ]
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'NotesFacet',
            Label : '{i18n>claims.facet.notes}',
            Target: '@UI.FieldGroup#ClaimNotes'
        }
    ],

    UI.FieldGroup #ClaimSummary : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            { Value : claim_number, Label : '{i18n>claims.field.claimNumber}' },
            { Value : status, Label : '{i18n>claims.field.status}' },
            { Value : received_at, Label : '{i18n>claims.field.receivedAt}' },
            { Value : incident_date, Label : '{i18n>claims.field.incidentDate}' },
            { Value : incident_location, Label : '{i18n>claims.field.incidentLocation}' },
            { Value : policy_number, Label : '{i18n>claims.field.policyNumber}' },
            { Value : vehicle_license, Label : '{i18n>claims.field.vehicleLicense}' },
            { Value : vehicle_vin, Label : '{i18n>claims.field.vehicleVin}' },
            { Value : claimant_name, Label : '{i18n>claims.field.claimantName}' },
            { Value : claimant_email, Label : '{i18n>claims.field.claimantEmail}' },
            { Value : claimant_phone, Label : '{i18n>claims.field.claimantPhone}' },
            { Value : estimated_cost, Label : '{i18n>claims.field.estimatedCost}' },
            { Value : severity_score, Label : '{i18n>claims.field.severityScore}' },
            { Value : fraud_score, Label : '{i18n>claims.field.fraudScore}' }
        ]
    },

    UI.FieldGroup #ClaimNotes : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            { Value : description_short, Label : '{i18n>claims.field.description}', ![@UI.MultiLineText] : true },
            { Value : notes, Label : '{i18n>claims.field.notes}', ![@UI.MultiLineText] : true }
        ]
    }
);

// Action Section to upload attachment (bound to Claim) – appears on Object Page
annotate service.Claims with @(
    UI.FieldGroup #AttachmentActions : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            {
                $Type  : 'UI.DataFieldForAction',
                Action : 'ClaimsService.uploadLocalFileToClaim',
                Label  : 'Anhang (Server-Pfad) hochladen'
            }
        ]
    }
);

// Make action available only in Draft mode (UI hides it for active)
annotate service.Claims with actions {
    uploadLocalFileToClaim @(
        Core.OperationAvailable : { $edmJson: { $Not: { $Path: 'IsActiveEntity' } } },
        Common.SideEffects      : { TargetEntities: [ 'attachments' ] }
    );
};

annotate service.Claims with {
    status      @Common.Text : status_text.name
                @UI.TextArrangement : #TextOnly
                @Common.ValueList : {
                    CollectionPath : 'ClaimStatusTexts',
                    SearchSupported : true,
                    Parameters : [
                        {
                            $Type              : 'Common.ValueListParameterInOut',
                            LocalDataProperty  : status,
                            ValueListProperty  : 'code'
                        },
                        {
                            $Type             : 'Common.ValueListParameterDisplayOnly',
                            ValueListProperty : 'name'
                        }
                    ]
                };
    status_text @UI.Hidden : true;
};

/* =========================================================
 * ClaimDocuments (Sub Entity)
 * =======================================================*/
annotate service.ClaimDocuments with @(
    UI.LineItem : [
        { Value : filename, Label : '{i18n>claimDocuments.field.filename}' },
        { Value : doc_type, Label : '{i18n>claimDocuments.field.docType}' },
        { Value : parsed_meta, Label : '{i18n>claimDocuments.field.parsedMeta}' },
        { Value : extracted_text, Label : '{i18n>claimDocuments.field.extractedText}' }
    ],
    UI.HeaderInfo : {
        TypeName       : '{i18n>claimDocuments.entity.single}',
        TypeNamePlural : '{i18n>claimDocuments.entity.plural}',
        Title          : { Value : filename },
        Description    : { Value : doc_type }
    }
);

annotate model.Claims with {
    claim_number      @Common.Label : '{i18n>claims.field.claimNumber}';
    status            @Common.Label : '{i18n>claims.field.status}'
                     @UI.TextArrangement : #TextOnly;
    received_at       @Common.Label : '{i18n>claims.field.receivedAt}';
    incident_date     @Common.Label : '{i18n>claims.field.incidentDate}';
    incident_location @Common.Label : '{i18n>claims.field.incidentLocation}';
    policy_number     @Common.Label : '{i18n>claims.field.policyNumber}';
    vehicle_license   @Common.Label : '{i18n>claims.field.vehicleLicense}';
    vehicle_vin       @Common.Label : '{i18n>claims.field.vehicleVin}';
    claimant_name     @Common.Label : '{i18n>claims.field.claimantName}';
    claimant_email    @Common.Label : '{i18n>claims.field.claimantEmail}';
    claimant_phone    @Common.Label : '{i18n>claims.field.claimantPhone}';
    estimated_cost    @Common.Label : '{i18n>claims.field.estimatedCost}';
    severity_score    @Common.Label : '{i18n>claims.field.severityScore}';
    fraud_score       @Common.Label : '{i18n>claims.field.fraudScore}';
    description_short @Common.Label : '{i18n>claims.field.description}';
    notes             @Common.Label : '{i18n>claims.field.notes}';
    status_text       @UI.Hidden : true;
};

annotate model.ClaimDocuments with {
    filename       @Common.Label : '{i18n>claimDocuments.field.filename}';
    doc_type       @Common.Label : '{i18n>claimDocuments.field.docType}';
    parsed_meta    @Common.Label : '{i18n>claimDocuments.field.parsedMeta}'
                   @UI.MultiLineText : true;
    extracted_text @Common.Label : '{i18n>claimDocuments.field.extractedText}'
                   @UI.MultiLineText : true;
};

/* =========================================================
 * Attachments (Composition of Claims)
 * =======================================================*/
annotate service.Attachments with @(
    UI.LineItem : [
        { $Type : 'UI.DataField', Value : contentUrl, @HTML5.CssDefaults : { width : '12em' } },
        { Value : fileName,  Label : 'Dateiname' },
        { Value : mediaType, Label : 'MIME-Typ' },
        { Value : size,      Label : 'Dateigröße' }
    ],
    UI.HeaderInfo : {
        TypeName       : 'Anhang',
        TypeNamePlural : 'Anhänge',
        Title          : { Value : fileName },
        Description    : { Value : mediaType }
    },
    UI.MediaResource : { Stream : content },
    Common.SideEffects : {
        SourceProperties : ['content'],
        TargetProperties : ['size','sha256']
    }
);

// Mark preview URL as image
annotate service.Attachments with {
    contentUrl @UI.IsImageUrl : true;
};
