using StammtischService as service from '../srv/service';
using { sap.stammtisch as model }   from '../db/schema';


/* =========================================================
 * Stammtische (Service-Entität)
 * =======================================================*/
annotate service.Stammtische with @(
    UI.HeaderInfo : {
        TypeName        : 'Stammtisch',
        TypeNamePlural  : 'Stammtische',
        Title           : { Value : thema },
        Description     : { Value : ort }
    },

    UI.FieldGroup #GeneratedGroup : {
        $Type : 'UI.FieldGroupType',
        Data  : [
            { Value : thema },
            { Value : datum },
            { Value : ort  },
            {
            $Type  : 'UI.DataFieldWithNavigationPath',   // V4-konform
            Label  : 'Präsentator',
            Value  : praesentator,          // Navigation Property, nicht _ID
            Target : 'praesentator'         // erzeugt Link zur Presenter-OP
            },
            { Value : notizen }
        ]
    },

    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'StammtischGeneralInfoFacet',
            Label : 'Allgemeine Informationen',
            Target: '@UI.FieldGroup#GeneratedGroup'
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID    : 'TeilnehmerFacet',
            Label : 'Teilnehmer',
            Target: 'teilnehmer/@UI.LineItem'
        }
    ],

    UI.LineItem : [
        { Value : thema },
        { Value : datum },
        { Value : ort  },
        {
            Value : praesentator.name,
            Label : 'Präsentator'
        },
        { Value : notizen, ![@UI.Importance] : #Low }
    ]
) {
    /* -------- Value Help & Semantik für Präsentator -------- */
    praesentator @Common.ValueList : {
        $Type          : 'Common.ValueListType',
        CollectionPath : 'Praesentatoren',
        Parameters     : [
            {
                $Type              : 'Common.ValueListParameterInOut',
                LocalDataProperty  : praesentator_ID,
                ValueListProperty  : 'ID'
            },
            {
                $Type             : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty : 'name'
            },
            {
                $Type             : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty : 'email'
            }
        ]
    };
    praesentator @Common.SemanticObject : 'Praesentator';

    /* -------- Fix: Line-Item auf Navigation Property -------- */
    teilnehmer @(
        UI.LineItem : [
            { Value : name,  Label : 'Name'  },
            { Value : email, Label : 'E-Mail'}
        ],
        UI.Identification : [
            { Value : name }
        ]
    );
};   /* <<———— Semikolon */


/* =========================================================
 * Präsentatoren (Service-Entität)
 * =======================================================*/
annotate service.Praesentatoren with @(
    UI.HeaderInfo : {
        TypeName       : 'Präsentator',
        TypeNamePlural : 'Präsentatoren',
        Title          : { Value : name },
        Description    : { Value : email }
    },

    UI.LineItem : [
        { Value : name },
        { Value : email },
        { Value : linkedin, ![@UI.Importance] : #Low }
    ],

    UI.Facets : [
        {
            $Type  : 'UI.ReferenceFacet',
            Label  : 'Allgemeine Informationen',
            Target : '@UI.FieldGroup#PraesentatorGeneralInfo'
        },
        {
            $Type  : 'UI.ReferenceFacet',
            Label  : 'Gehaltene Stammtische',
            Target : 'stammtische/@UI.LineItem'
        }
    ],

    UI.FieldGroup #PraesentatorGeneralInfo : {
        Data : [
            { Value : name     },
            { Value : email    },
            { Value : linkedin }
        ]
    }
);   /* <<———— Semikolon */


/* =========================================================
 * Teilnehmer (Service-Entität)
 * =======================================================*/
annotate service.Teilnehmer with @(
    UI.HeaderInfo : {
        TypeName       : 'Teilnehmer',
        TypeNamePlural : 'Teilnehmer',
        Title          : { Value : name  },
        Description    : { Value : email }
    },

    UI.LineItem : [
        { Value : name,  Label : 'Name'  },
        { Value : email, Label : 'E-Mail'}
    ],

    UI.Facets : [
        {
            $Type  : 'UI.ReferenceFacet',
            Label  : 'Details zum Teilnehmer',
            Target : '@UI.FieldGroup#TeilnehmerDetails'
        }
    ],

    UI.FieldGroup #TeilnehmerDetails : {
        Data : [
            { Value : name  },
            { Value : email }
        ]
    }
);   /* <<———— Semikolon */


/* =========================================================
 * Modell-Annotationen (optional)
 * =======================================================*/
annotate model.Praesentatoren with {
    stammtische @(
        UI.LineItem : [
            { Value : thema },
            { Value : datum },
            { Value : ort   }
        ],
        UI.Identification : [
            { Value : thema }
        ]
    );
};  /* <<———— Semikolon */

annotate model.Stammtische with {
    teilnehmer @(
        UI.LineItem : [
            { Value : name,  Label : 'Name'  },
            { Value : email, Label : 'E-Mail'}
        ],
        UI.Identification : [
            { Value : name }
        ]
    );
};  /* <<———— Semikolon */
