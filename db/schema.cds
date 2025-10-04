namespace kfz.claims;

using { cuid, managed, sap.common.CodeList } from '@sap/cds/common';

type Money : Decimal(13,2);
type ClaimStatus : String enum {
  eingegangen = 'Eingegangen';
  in_pruefung = 'In Prüfung';
  freigegeben = 'Freigegeben';
  abgelehnt = 'Abgelehnt';
}
type DocumentType : String enum { foto; kalkulation; polizeibericht; sonstiges; }

entity ClaimStatusTexts : CodeList {
  key code : ClaimStatus;
}

entity Claims : cuid, managed {
  key ID                 : UUID @(Core.Computed: true);
  claim_number           : String(40);
  received_at            : DateTime;
  status                 : ClaimStatus;
  status_text            : Association to ClaimStatusTexts on status_text.code = status;
  claimant_name          : String(100);
  claimant_email         : String(120);
  claimant_phone         : String(40);
  policy_number          : String(40);
  vehicle_license        : String(20);
  vehicle_vin            : String(40);
  incident_date          : DateTime;
  incident_location      : String(120);
  description_short      : String(500);
  estimated_cost         : Money;
  severity_score         : Integer;
  fraud_score            : Integer;
  notes                  : LargeString;

  documents              : Composition of many ClaimDocuments
                             on documents.claim = $self;
}

entity ClaimDocuments : cuid, managed {
  key ID           : UUID @(Core.Computed: true);
  claim            : Association to Claims;
  filename         : String(200);
  doc_type         : DocumentType;
  parsed_meta      : LargeString;
  extracted_text   : LargeString;
}
