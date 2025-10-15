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

  // Attachments participate in the Claim draft lifecycle via composition
  attachments            : Composition of many Attachments
                              on attachments.refClaim = $self;
}

entity ClaimDocuments : cuid, managed {
  key ID           : UUID @(Core.Computed: true);
  claim            : Association to Claims;
  filename         : String(200);
  doc_type         : DocumentType;
  parsed_meta      : LargeString;
  extracted_text   : LargeString;
}

/**
 * Binary attachments persisted in the DB with media stream support.
 * Images, spreadsheets, and other files are stored in `content` with
 * MIME type in `mediaType` so OData can serve `$value` correctly.
 */
entity Attachments : cuid, managed {
  key ID        : UUID @(Core.Computed: true);
  fileName      : String(255);
  mediaType     : String @Core.IsMediaType;
  size          : Integer;
  sha256        : String(128);
  sourcePath    : String(500);
  note          : String(500);
  refClaim      : Association to Claims; // optional link to a claim

  content       : LargeBinary
                   @Core.MediaType: mediaType
                   @Core.ContentDisposition.Filename: fileName;
}

/**
 * Excel import jobs referencing an attachment. Content is not duplicated; the
 * import process reads the attachment and maps rows into domain entities later.
 */
entity ExcelImports : cuid, managed {
  key ID         : UUID @(Core.Computed: true);
  fileName       : String(255);
  mediaType      : String @Core.IsMediaType;
  size           : Integer;
  sha256         : String(128);
  sourcePath     : String(500);
  attachment     : Association to Attachments;
  status         : String enum { NEW; PROCESSING; DONE; ERROR; };
  rowsImported   : Integer;
  log            : LargeString;
}
