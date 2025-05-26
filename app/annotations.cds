using StammtischService as service from '../srv/service';
annotate service.Stammtische with @(
    UI.FieldGroup #GeneratedGroup : {
        $Type : 'UI.FieldGroupType',
        Data : [
            {
                $Type : 'UI.DataField',
                Label : 'thema',
                Value : thema,
            },
            {
                $Type : 'UI.DataField',
                Label : 'datum',
                Value : datum,
            },
            {
                $Type : 'UI.DataField',
                Label : 'ort',
                Value : ort,
            },
            {
                $Type : 'UI.DataField',
                Label : 'notizen',
                Value : notizen,
            },
        ],
    },
    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'GeneratedFacet1',
            Label : 'General Information',
            Target : '@UI.FieldGroup#GeneratedGroup',
        },
    ],
    UI.LineItem : [
        {
            $Type : 'UI.DataField',
            Label : 'thema',
            Value : thema,
        },
        {
            $Type : 'UI.DataField',
            Label : 'datum',
            Value : datum,
        },
        {
            $Type : 'UI.DataField',
            Label : 'ort',
            Value : ort,
        },
        {
            $Type : 'UI.DataField',
            Label : 'notizen',
            Value : notizen,
        },
    ],
);

annotate service.Stammtische with {
    praesentator @Common.ValueList : {
        $Type : 'Common.ValueListType',
        CollectionPath : 'Praesentatoren',
        Parameters : [
            {
                $Type : 'Common.ValueListParameterInOut',
                LocalDataProperty : praesentator_ID,
                ValueListProperty : 'ID',
            },
            {
                $Type : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty : 'name',
            },
            {
                $Type : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty : 'email',
            },
            {
                $Type : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty : 'linkedin',
            },
        ],
    }
};

